/**
 * vibeshare signaling rendezvous — a Cloudflare Worker + one Durable Object
 * per shareId. It exists for exactly one job: carry the WebRTC
 * offer/answer/ICE handshake between a vibeshare host (`vibeshare --public`)
 * and browser viewers. Session bytes never cross it — they flow host→viewer
 * over an AES-256-GCM DataChannel; the key lives only in the share URL
 * `#fragment`, which browsers never send to any server.
 *
 * The Worker is the identity authority (this is what makes the rendezvous
 * safe to run as a public service):
 *
 *   - viewerIds are MINTED here (crypto.randomUUID), one per viewer socket —
 *     a viewer cannot choose or claim another viewer's id;
 *   - every relayed frame is STAMPED with the connection's own
 *     (shareId, viewerId, from) — client-supplied identity fields are
 *     discarded, so there is no cross-pair injection or impersonation;
 *   - the host authenticates with a host-secret it minted when the share was
 *     created; the first secret presented for a share is bound durably and
 *     later host connections must match (viewers never see it);
 *   - the relay is a whitelist: ONLY rtc-offer / rtc-answer / rtc-ice with
 *     the expected string fields are forwarded, reconstructed server-side.
 *     Keys, session bytes, and every other frame shape are dropped.
 *
 * Availability / isolation hardening (see ./limits.ts for tunable constants):
 *
 *   - max viewers per share (host exempt).
 *
 * Protocol (mirrored by src/webrtc/wsSignaling.ts + src/webrtc/viewerPage.ts):
 *
 *   GET /vibeshare/s/<id>                          → the viewer page (HTML)
 *   GET /vibeshare/ws/host?share=<id>&secret=<s>   → host socket
 *   GET /vibeshare/ws/viewer?share=<id>            → viewer socket
 *   GET /vibeshare/health                          → liveness
 */
import { viewerPage } from '../../src/webrtc/viewerPage.js';
import {
  MAX_VIEWERS,
  abandonedCleanupDeadline,
  atViewerCap,
  countViewers,
  hostActivityDeadline,
  pruneRateLimitMap,
  recordConnection,
} from './limits.js';

export interface Env {
  readonly SHARES: DurableObjectNamespace;
}

const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Relay frames larger than this are dropped (SDPs are a few KB). */
const MAX_FRAME_BYTES = 32 * 1024;

const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // Self-contained page: inline script/style only, sockets + WebRTC to self.
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/vibeshare/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (request.method === 'GET' && SHARE_ID_RE.test(pageShareId(url.pathname) ?? '')) {
      return new Response(viewerPage(), { headers: PAGE_HEADERS });
    }

    if (url.pathname === '/vibeshare/ws/host' || url.pathname === '/vibeshare/ws/viewer') {
      const shareId = url.searchParams.get('share') ?? '';
      if (!SHARE_ID_RE.test(shareId)) {
        return new Response('missing or invalid share id', { status: 400 });
      }
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return new Response('expected a WebSocket upgrade', { status: 426 });
      }
      const room = env.SHARES.get(env.SHARES.idFromName(shareId));
      return room.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function pageShareId(pathname: string): string | null {
  const m = /^\/vibeshare\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** Per-connection state, serialized into the socket (survives hibernation). */
interface Attachment {
  readonly role: 'host' | 'viewer';
  readonly shareId: string;
  readonly viewerId?: string;
}

/**
 * One Durable Object per shareId: holds the host socket + all viewer sockets
 * for a single share and fans the handshake out between them.
 */
export class ShareRoom implements DurableObject {
  /**
   * Best-effort in-memory sliding window of recent connection timestamps per
   * CF-Connecting-IP. Resets on DO hibernation — defense-in-depth only.
   */
  private readonly connByIp = new Map<string, number[]>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const shareId = url.searchParams.get('share') ?? '';
    const isHost = url.pathname.endsWith('/ws/host');
    const now = Date.now();

    // Per-IP upgrade rate limit (host + viewer). Missing header shares one
    // "unknown" bucket so non-CF / local clients are still capped (fail closed).
    const ip = (request.headers.get('CF-Connecting-IP') ?? '').trim() || 'unknown';
    pruneRateLimitMap(this.connByIp, now);
    const prior = this.connByIp.get(ip) ?? [];
    const decision = recordConnection(prior, now);
    this.connByIp.set(ip, decision.timestamps);
    if (!decision.allowed) {
      return new Response('rate limit exceeded', { status: 429 });
    }

    if (isHost) {
      const secret = url.searchParams.get('secret') ?? '';
      if (secret.length < 16) {
        return new Response('missing or weak host secret', { status: 403 });
      }
      // TOFU binding: the first host secret presented for this share is bound
      // durably; later host connections must present the same secret.
      const bound = await this.ctx.storage.get<string>('hostSecret');
      if (bound === undefined) {
        await this.ctx.storage.put('hostSecret', secret);
      } else if (bound !== secret) {
        return new Response('forbidden: this share already has a host', { status: 403 });
      }
    } else {
      // Max viewers per share — refuse the upgrade before accepting (fail closed).
      const roles = this.socketRoles();
      if (atViewerCap(countViewers(roles), MAX_VIEWERS)) {
        return new Response('too many viewers', { status: 429 });
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (isHost) {
      // One live host per share: a reconnect with the right secret replaces
      // the old socket (its DataChannels re-handshake with new viewers).
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === 'host') ws.close(1012, 'host reconnected');
      }
      server.serializeAttachment({ role: 'host', shareId } satisfies Attachment);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ kind: 'host-ready' }));
      // Hard ceiling on storage life; reset on every host connect so a live
      // long share isn't wiped. alarm() re-arms while the host is still up.
      await this.ctx.storage.setAlarm(hostActivityDeadline(now));
    } else {
      // The Worker ASSIGNS the viewerId — the viewer never chooses one.
      const viewerId = crypto.randomUUID();
      server.serializeAttachment({ role: 'viewer', shareId, viewerId } satisfies Attachment);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ kind: 'assigned', viewerId }));
      this.hostSocket()?.send(JSON.stringify({ kind: 'viewer-joined', viewerId }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_FRAME_BYTES) return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    if (att.role === 'host') this.relayFromHost(att, msg);
    else if (att.viewerId !== undefined) this.relayFromViewer(att, att.viewerId, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'host') {
      // Host left: the share is over — close every viewer so pages show it.
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const otherAtt = other.deserializeAttachment() as Attachment | null;
        if (otherAtt?.role === 'viewer') other.close(1012, 'host left');
      }
      // No remaining sockets → reclaim storage shortly (don't hold hostSecret forever).
      const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
      if (remaining === 0) {
        await this.ctx.storage.setAlarm(abandonedCleanupDeadline(Date.now()));
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
  }

  /**
   * Alarm: storage reclaim at hard ceiling or abandoned short timer.
   * While a host is still connected, never wipe — re-arm the hard ceiling
   * so long live shares stay up.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.hostSocket()) {
      await this.ctx.storage.setAlarm(hostActivityDeadline(now));
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1013, 'share expired');
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAll();
  }

  // ------------------------------------------------------------- relay

  /** Host → one viewer. The host addresses a viewer; the share is its own. */
  private relayFromHost(att: Attachment, msg: Record<string, unknown>): void {
    const viewerId = msg['viewerId'];
    if (typeof viewerId !== 'string') return;
    const viewer = this.viewerSocket(viewerId);
    if (!viewer) return;
    if (msg['kind'] === 'rtc-offer' && typeof msg['sdp'] === 'string') {
      viewer.send(JSON.stringify({ kind: 'rtc-offer', shareId: att.shareId, viewerId, sdp: msg['sdp'] }));
      return;
    }
    if (msg['kind'] === 'rtc-ice' && typeof msg['candidate'] === 'string' && typeof msg['mid'] === 'string') {
      viewer.send(
        JSON.stringify({
          kind: 'rtc-ice',
          shareId: att.shareId,
          viewerId,
          candidate: msg['candidate'],
          mid: msg['mid'],
          from: 'host',
        }),
      );
    }
    // anything else: dropped — the relay is a whitelist.
  }

  /** Viewer → host. Identity is stamped from the CONNECTION, never the payload. */
  private relayFromViewer(att: Attachment, viewerId: string, msg: Record<string, unknown>): void {
    const host = this.hostSocket();
    if (!host) return;
    if (msg['kind'] === 'rtc-answer' && typeof msg['sdp'] === 'string') {
      host.send(JSON.stringify({ kind: 'rtc-answer', shareId: att.shareId, viewerId, sdp: msg['sdp'] }));
      return;
    }
    if (msg['kind'] === 'rtc-ice' && typeof msg['candidate'] === 'string' && typeof msg['mid'] === 'string') {
      host.send(
        JSON.stringify({
          kind: 'rtc-ice',
          shareId: att.shareId,
          viewerId,
          candidate: msg['candidate'],
          mid: msg['mid'],
          from: 'viewer',
        }),
      );
    }
  }

  private socketRoles(): Array<'host' | 'viewer'> {
    const roles: Array<'host' | 'viewer'> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role === 'host' || att?.role === 'viewer') roles.push(att.role);
    }
    return roles;
  }

  private hostSocket(): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role === 'host') return ws;
    }
    return undefined;
  }

  private viewerSocket(viewerId: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role === 'viewer' && att.viewerId === viewerId) return ws;
    }
    return undefined;
  }
}
