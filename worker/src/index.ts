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
 *   - the relay is a whitelist: rtc-offer / rtc-answer / rtc-ice (point-to-point
 *     handshake) plus presence / hello / chat / annotation / join-request /
 *     role-update (multi-party hub frames). Chat + annotation TEXT is
 *     end-to-end ciphertext — the Worker never decrypts it. Sender identity on
 *     chat/annotation/join-request is STAMPED from the connection attachment;
 *     annotation ids are minted here. Keys, session bytes, and every other
 *     frame shape are dropped.
 *
 * Availability / isolation hardening (see ./limits.ts for tunable constants):
 *
 *   - max viewers per share (host exempt);
 *   - per-IP sliding-window connection rate limit (CF-Connecting-IP);
 *   - DO storage cleanup alarm (hard ceiling + abandoned short reclaim);
 *   - viewer-with-no-host timeout (guessed/expired ids fail closed).
 *
 * Protocol (mirrored by src/webrtc/wsSignaling.ts + src/webrtc/viewerPage.ts):
 *
 *   GET /vibeshare/s/<id>                          → the viewer page (HTML)
 *   GET /vibeshare/ws/host?share=<id>&secret=<s>   → host socket
 *   GET /vibeshare/ws/viewer?share=<id>            → viewer socket
 *   GET /vibeshare/health                          → liveness
 */
// Pure helpers only — no Node Buffer / crypto (Worker-safe).
import { stampAnnotation } from '../../src/annotations.js';
import {
  buildPresenceRoster,
  defaultPresenceName,
  sanitizePresenceName,
  stampChatRelay,
} from '../../src/presenceChat.js';
import { viewerPage } from '../../src/webrtc/viewerPage.js';
import {
  MAX_VIEWERS,
  VIEWER_HOST_WAIT_MS,
  abandonedCleanupDeadline,
  atViewerCap,
  countViewers,
  hostActivityDeadline,
  pruneRateLimitMap,
  recordConnection,
  viewerHostWaitExpired,
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
  /** Display name from a hello frame (sanitized); may be empty until hello. */
  readonly name?: string;
  /** Epoch ms when this viewer socket connected (for no-host timeout). */
  readonly connectedAt?: number;
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
      server.serializeAttachment({
        role: 'host',
        shareId,
        name: 'host',
      } satisfies Attachment);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ kind: 'host-ready' }));
      // Hard ceiling on storage life; reset on every host connect so a live
      // long share isn't wiped. alarm() re-arms while the host is still up.
      await this.ctx.storage.setAlarm(hostActivityDeadline(now));
      this.broadcastPresence();
    } else {
      // The Worker ASSIGNS the viewerId — the viewer never chooses one.
      const viewerId = crypto.randomUUID();
      server.serializeAttachment({
        role: 'viewer',
        shareId,
        viewerId,
        name: defaultPresenceName('viewer', viewerId),
        connectedAt: now,
      } satisfies Attachment);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ kind: 'assigned', viewerId }));
      const host = this.hostSocket();
      if (host) {
        host.send(JSON.stringify({ kind: 'viewer-joined', viewerId }));
      } else {
        // No host yet: schedule a reject so a guessed id doesn't hold a socket.
        await this.ensureViewerHostWaitAlarm(now);
      }
      this.broadcastPresence();
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
    if (att.role === 'host') this.relayFromHost(ws, att, msg);
    else if (att.viewerId !== undefined) this.relayFromViewer(ws, att, att.viewerId, msg);
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
      return;
    }
    // Viewer left: rebroadcast roster so remaining peers drop the name.
    if (att?.role === 'viewer') this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
  }

  /**
   * Alarm fires for:
   *   1) viewer no-host wait expiry (close with 1013 "share not found");
   *   2) hard ceiling / abandoned cleanup (close leftovers + deleteAll).
   *
   * While a host is connected, never wipe — re-arm the hard ceiling instead
   * so long live shares stay up.
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // Host still here: keep the share alive (extend hard ceiling). Live
    // viewers that arrived while host was up do not use the no-host timer.
    if (this.hostSocket()) {
      await this.ctx.storage.setAlarm(hostActivityDeadline(now));
      return;
    }

    // Close viewers whose no-host wait has elapsed.
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role !== 'viewer' || att.connectedAt === undefined) continue;
      if (viewerHostWaitExpired(att.connectedAt, now)) {
        try {
          ws.close(1013, 'share not found');
        } catch {
          // already closed
        }
      }
    }

    // More viewers still inside their wait window → schedule the next expiry.
    const nextWait = this.nextViewerHostWaitAlarm(now);
    if (nextWait !== null) {
      await this.ctx.storage.setAlarm(nextWait);
      return;
    }

    // No host and no pending viewer wait → wipe durable state + leftover sockets.
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

  /** Host → one viewer (rtc) or multi-party (hello/chat). */
  private relayFromHost(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): void {
    if (this.handlePresenceChat(ws, att, msg)) return;

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

  /** Viewer → host (rtc) or multi-party (hello/chat). Identity from CONNECTION. */
  private relayFromViewer(
    ws: WebSocket,
    att: Attachment,
    viewerId: string,
    msg: Record<string, unknown>,
  ): void {
    if (this.handlePresenceChat(ws, att, msg, viewerId)) return;

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

  /**
   * Multi-party hub frames (hello / chat / annotation / join-request /
   * role-update). Returns true when the message was handled (so rtc relay
   * should not also try it).
   */
  private handlePresenceChat(
    ws: WebSocket,
    att: Attachment,
    msg: Record<string, unknown>,
    connectionViewerId?: string,
  ): boolean {
    if (msg['kind'] === 'hello') {
      const name =
        sanitizePresenceName(msg['name']) ||
        defaultPresenceName(att.role, connectionViewerId ?? att.viewerId ?? 'host');
      // Update THIS socket's attachment so the next roster picks up the name.
      const next: Attachment = {
        role: att.role,
        shareId: att.shareId,
        name,
        ...(att.viewerId !== undefined ? { viewerId: att.viewerId } : {}),
        ...(att.connectedAt !== undefined ? { connectedAt: att.connectedAt } : {}),
      };
      ws.serializeAttachment(next);
      this.broadcastPresence();
      return true;
    }

    if (msg['kind'] === 'chat') {
      const viewerId =
        att.role === 'host' ? 'host' : (connectionViewerId ?? att.viewerId ?? '');
      if (viewerId.length === 0) return true; // drop, handled
      // Live attachment may have a fresher name than the message-time snapshot.
      const live = ws.deserializeAttachment() as Attachment | null;
      const liveName = live?.name ?? att.name ?? '';
      const stamped = stampChatRelay({
        viewerId,
        name: liveName,
        role: att.role,
        text: msg['text'],
      });
      if (!stamped) return true; // bad ciphertext — drop
      // Discard any client-supplied identity: reconstruct server-side only.
      this.broadcastAll(stamped);
      return true;
    }

    // Viewer/host → everyone: a pinned comment anchored to a feed seq.
    // Identity stamped from the CONNECTION; id minted here; text stays
    // ciphertext. Only seq (anchor) + replyTo (threading) pass through.
    if (msg['kind'] === 'annotation') {
      const viewerId =
        att.role === 'host' ? 'host' : (connectionViewerId ?? att.viewerId ?? '');
      if (viewerId.length === 0) return true; // drop, handled
      // Live attachment may have a fresher name than the message-time snapshot.
      const live = ws.deserializeAttachment() as Attachment | null;
      const liveName = live?.name ?? att.name ?? '';
      const stamped = stampAnnotation({
        id: crypto.randomUUID(),
        viewerId,
        name: liveName,
        role: att.role,
        seq: msg['seq'],
        text: msg['text'],
        replyTo: msg['replyTo'],
      });
      if (!stamped) return true; // bad payload — drop
      this.broadcastAll(stamped);
      return true;
    }

    // Viewer → host: request to drive. Identity from CONNECTION only.
    if (msg['kind'] === 'join-request') {
      if (att.role !== 'viewer') return true; // host cannot self-request
      const viewerId = connectionViewerId ?? att.viewerId ?? '';
      if (viewerId.length === 0) return true;
      const live = ws.deserializeAttachment() as Attachment | null;
      const name =
        sanitizePresenceName(live?.name ?? att.name) ||
        defaultPresenceName('viewer', viewerId);
      const host = this.hostSocket();
      if (host) {
        host.send(
          JSON.stringify({
            kind: 'join-request',
            viewerId,
            name,
          }),
        );
      }
      return true;
    }

    // Host → one viewer: role decision after approve/deny.
    if (msg['kind'] === 'role-update') {
      if (att.role !== 'host') return true; // viewers cannot mint role updates
      const viewerId = typeof msg['viewerId'] === 'string' ? msg['viewerId'] : '';
      if (viewerId.length === 0) return true;
      const role =
        msg['role'] === 'collaborator'
          ? 'collaborator'
          : msg['role'] === 'spectator'
            ? 'spectator'
            : null;
      if (!role) return true;
      const joinRequest =
        msg['joinRequest'] === 'approved' ||
        msg['joinRequest'] === 'denied' ||
        msg['joinRequest'] === 'pending' ||
        msg['joinRequest'] === 'none'
          ? msg['joinRequest']
          : null;
      if (!joinRequest) return true;
      const viewer = this.viewerSocket(viewerId);
      if (viewer) {
        viewer.send(
          JSON.stringify({
            kind: 'role-update',
            viewerId,
            role,
            joinRequest,
          }),
        );
      }
      return true;
    }

    return false;
  }

  /** Fan a presence roster snapshot to every connected socket. */
  private broadcastPresence(): void {
    const attachments: Attachment[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att) attachments.push(att);
    }
    const viewers = buildPresenceRoster(attachments);
    this.broadcastAll({ kind: 'presence', viewers });
  }

  private broadcastAll(frame: unknown): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // socket already closing
      }
    }
  }

  // ------------------------------------------------------------- helpers

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

  /**
   * Ensure a DO alarm will fire by the soonest viewer no-host deadline.
   * setAlarm replaces any previous alarm; only bump if we need an earlier one
   * (do not postpone an abandoned/hard-ceiling cleanup already scheduled sooner).
   */
  private async ensureViewerHostWaitAlarm(connectedAt: number): Promise<void> {
    const due = connectedAt + VIEWER_HOST_WAIT_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || due < existing) {
      await this.ctx.storage.setAlarm(due);
    }
  }

  /** Next connectedAt+VIEWER_HOST_WAIT_MS among still-waiting viewers, or null. */
  private nextViewerHostWaitAlarm(now: number): number | null {
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role !== 'viewer' || att.connectedAt === undefined) continue;
      const due = att.connectedAt + VIEWER_HOST_WAIT_MS;
      if (due <= now) continue;
      if (next === null || due < next) next = due;
    }
    return next;
  }
}
