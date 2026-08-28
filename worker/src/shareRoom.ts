/**
 * ShareRoom — one Durable Object per shareId. Holds the host socket + all
 * viewer sockets for a single share and fans the WebRTC handshake between
 * them. The relay is a whitelist: hello/chat/annotation/join-request/
 * role-update are handled via the presence hub, rtc-offer/answer/ice are
 * forwarded host↔viewer, rtc-ice-servers is host→viewer ONLY, and every
 * other frame shape is dropped.
 *
 * Identity rule (see index.ts): sender identity is STAMPED from the
 * connection attachment — client-supplied viewerId/name never reach the
 * wire.
 *
 * The class stays small by delegating to two sibling modules of stateless
 * helpers: roomIo.ts (socket/attachment/alarm/broadcast) and presenceHub.ts
 * (multi-party frame handlers). The connection attachment shape lives in
 * roomIo.ts and is re-exported here.
 */
import {
  MAX_VIEWERS,
  abandonedCleanupDeadline,
  atViewerCap,
  countViewers,
  hostActivityDeadline,
  pruneRateLimitMap,
  recordConnection,
} from './limits.js';
import {
  type Attachment,
  acceptHostConnection,
  acceptViewerConnection,
  broadcastPresence,
  closeAll,
  closeExpiredViewerWaits,
  hostSocket,
  nextViewerHostWaitAlarm,
  socketRoles,
  viewerSocket,
} from './roomIo.js';
import {
  presenceAnnotation,
  presenceChat,
  presenceHello,
  presenceJoinRequest,
  presenceRoleUpdate,
} from './presenceHub.js';
import type { Env } from './env.js';

export type { Attachment } from './roomIo.js';

/** Relay frames larger than this are dropped (SDPs are a few KB). */
const MAX_FRAME_BYTES = 32 * 1024;

/** Cap on relayed ICE server entries (a STUN/TURN bootstrap list is tiny). */
const MAX_ICE_SERVERS = 8;

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
    const blocked = this.rateLimit(request, now);
    if (blocked) return blocked;

    if (isHost) {
      // TOFU binding: the first host secret presented for this share is bound
      // durably; later host connections must present the same secret.
      const secretBlocked = await this.bindHostSecret(url.searchParams.get('secret') ?? '');
      if (secretBlocked) return secretBlocked;
    } else if (this.viewerCapReached()) {
      // Max viewers per share — refuse the upgrade before accepting (fail closed).
      return new Response('too many viewers', { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (isHost) {
      // One live host per share: a reconnect with the right secret replaces
      // the old socket (its DataChannels re-handshake with new viewers).
      await acceptHostConnection(this.ctx, server, shareId, now);
    } else {
      await acceptViewerConnection(this.ctx, server, shareId, now);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Per-IP sliding-window upgrade rate limit. Returns a 429 Response when the
   * window cap is hit, or null so the connection may proceed.
   */
  private rateLimit(request: Request, now: number): Response | null {
    const ip = (request.headers.get('CF-Connecting-IP') ?? '').trim() || 'unknown';
    pruneRateLimitMap(this.connByIp, now);
    const prior = this.connByIp.get(ip) ?? [];
    const decision = recordConnection(prior, now);
    this.connByIp.set(ip, decision.timestamps);
    if (!decision.allowed) {
      return new Response('rate limit exceeded', { status: 429 });
    }
    return null;
  }

  /**
   * Host-secret TOFU binding: the first secret presented for this share is
   * bound durably; later host connections must present the same secret.
   * Returns a 403 Response when rejected, or null so the socket may proceed.
   */
  private async bindHostSecret(secret: string): Promise<Response | null> {
    if (secret.length < 16) {
      return new Response('missing or weak host secret', { status: 403 });
    }
    const bound = await this.ctx.storage.get<string>('hostSecret');
    if (bound === undefined) {
      await this.ctx.storage.put('hostSecret', secret);
    } else if (bound !== secret) {
      return new Response('forbidden: this share already has a host', { status: 403 });
    }
    return null;
  }

  /** True when a new viewer socket must be refused (max viewers per share). */
  private viewerCapReached(): boolean {
    return atViewerCap(countViewers(socketRoles(this.ctx)), MAX_VIEWERS);
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
    if (att?.role === 'viewer') broadcastPresence(this.ctx);
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
    if (hostSocket(this.ctx)) {
      await this.ctx.storage.setAlarm(hostActivityDeadline(now));
      return;
    }

    // Close viewers whose no-host wait has elapsed.
    closeExpiredViewerWaits(this.ctx, now);

    // More viewers still inside their wait window → schedule the next expiry.
    const nextWait = nextViewerHostWaitAlarm(this.ctx, now);
    if (nextWait !== null) {
      await this.ctx.storage.setAlarm(nextWait);
      return;
    }

    // No host and no pending viewer wait → wipe durable state + leftover sockets.
    closeAll(this.ctx, 1013, 'share expired');
    await this.ctx.storage.deleteAll();
  }

  // ------------------------------------------------------------- relay

  /** Host → one viewer (rtc) or multi-party (hello/chat). */
  private relayFromHost(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): void {
    if (this.handlePresenceChat(ws, att, msg)) return;

    const viewerId = msg['viewerId'];
    if (typeof viewerId !== 'string') return;
    const viewer = viewerSocket(this.ctx, viewerId);
    if (!viewer) return;

    // Whitelist dispatch on `kind` (peer-controlled); guarded in each helper.
    switch (msg['kind']) {
      case 'rtc-offer':
        this.relayRtcOffer(viewer, att, viewerId, msg);
        return;
      case 'rtc-ice-servers':
        this.relayIceServers(viewer, att, viewerId, msg);
        return;
      case 'rtc-ice':
        this.relayRtcIce({ target: viewer, att, viewerId, msg, from: 'host' });
        return;
      default:
        return; // anything else: dropped — the relay is a whitelist.
    }
  }

  /** Host → one viewer: an rtc-offer (SDP guard kept as before). */
  private relayRtcOffer(
    viewer: WebSocket,
    att: Attachment,
    viewerId: string,
    msg: Record<string, unknown>,
  ): void {
    if (typeof msg['sdp'] !== 'string') return;
    viewer.send(JSON.stringify({ kind: 'rtc-offer', shareId: att.shareId, viewerId, sdp: msg['sdp'] }));
  }

  /** Host → viewer ONLY: the host's STUN/TURN bootstrap (BYO TURN), relayed verbatim. */
  private relayIceServers(
    viewer: WebSocket,
    att: Attachment,
    viewerId: string,
    msg: Record<string, unknown>,
  ): void {
    // The Worker never inspects creds — but the list is capped.
    if (!Array.isArray(msg['iceServers']) || msg['iceServers'].length > MAX_ICE_SERVERS) return;
    viewer.send(
      JSON.stringify({ kind: 'rtc-ice-servers', shareId: att.shareId, viewerId, iceServers: msg['iceServers'] }),
    );
  }

  /**
   * host→viewer or viewer→host: an rtc-ice candidate pair (guards kept).
   *
   * `from` is passed in by the caller rather than read off the attachment.
   * Each relay path stamps its own literal, exactly as the two separate
   * pre-refactor blocks did, so the direction stamp stays correct here
   * without depending on how webSocketMessage happened to dispatch.
   */
  private relayRtcIce(opts: {
    readonly target: WebSocket;
    readonly att: Attachment;
    readonly viewerId: string;
    readonly msg: Record<string, unknown>;
    readonly from: 'host' | 'viewer';
  }): void {
    const { target, att, viewerId, msg, from } = opts;
    if (typeof msg['candidate'] !== 'string' || typeof msg['mid'] !== 'string') return;
    target.send(
      JSON.stringify({
        kind: 'rtc-ice',
        shareId: att.shareId,
        viewerId,
        candidate: msg['candidate'],
        mid: msg['mid'],
        from,
      }),
    );
  }

  /** Viewer → host (rtc) or multi-party (hello/chat). Identity from CONNECTION. */
  private relayFromViewer(
    ws: WebSocket,
    att: Attachment,
    viewerId: string,
    msg: Record<string, unknown>,
  ): void {
    if (this.handlePresenceChat(ws, att, msg, viewerId)) return;

    // rtc-ice-servers is host→viewer ONLY (TURN creds are the host's own) —
    // a viewer-sent copy is rejected outright, never relayed.
    if (msg['kind'] === 'rtc-ice-servers') return;

    const host = hostSocket(this.ctx);
    if (!host) return;

    switch (msg['kind']) {
      case 'rtc-answer':
        this.relayRtcAnswer(host, att, viewerId, msg);
        return;
      case 'rtc-ice':
        this.relayRtcIce({ target: host, att, viewerId, msg, from: 'viewer' });
        return;
      default:
        return; // anything else: dropped — the relay is a whitelist.
    }
  }

  /** Viewer → host: an rtc-answer (SDP guard kept as before). */
  private relayRtcAnswer(
    host: WebSocket,
    att: Attachment,
    viewerId: string,
    msg: Record<string, unknown>,
  ): void {
    if (typeof msg['sdp'] !== 'string') return;
    host.send(JSON.stringify({ kind: 'rtc-answer', shareId: att.shareId, viewerId, sdp: msg['sdp'] }));
  }

  /**
   * Multi-party hub frames (hello / chat / annotation / join-request /
   * role-update). Returns true when the message was handled (so rtc relay
   * should not also try it). `kind` is peer-controlled — dispatch via
   * switch, each case delegates to a presence hub handler.
   */
  private handlePresenceChat(
    ws: WebSocket,
    att: Attachment,
    msg: Record<string, unknown>,
    connectionViewerId?: string,
  ): boolean {
    const endpoint = { ctx: this.ctx, ws };
    switch (msg['kind']) {
      case 'hello':
        return presenceHello(endpoint, att, msg, connectionViewerId);
      case 'chat':
        return presenceChat(endpoint, att, msg, connectionViewerId);
      case 'annotation':
        return presenceAnnotation(endpoint, att, msg, connectionViewerId);
      case 'join-request':
        return presenceJoinRequest(endpoint, att, msg, connectionViewerId);
      case 'role-update':
        return presenceRoleUpdate(endpoint, att, msg);
      default:
        return false;
    }
  }
}