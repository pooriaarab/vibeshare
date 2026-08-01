/**
 * WsSignaling — a real `SignalingChannel` over WebSocket (drop-in for
 * `LoopbackSignaling`; `WebRtcTransport` takes it unchanged).
 *
 * Talks to the vibeshare signaling rendezvous (the getvibe.dev Cloudflare
 * Worker by default, or any BYO endpoint — see `src/config.ts`). The
 * rendezvous carries ONLY the offer/answer/ICE handshake; session bytes stay
 * peer-to-peer on the AES-GCM DataChannel, and the key never crosses this
 * channel (it lives in the share URL `#fragment`).
 *
 * Wire protocol (JSON text frames, mirrored by `worker/src/index.ts` and
 * `src/webrtc/viewerPage.ts`):
 *
 *   connect host:    GET {base}/ws/host?share=<shareId>&secret=<hostSecret>
 *   connect viewer:  GET {base}/ws/viewer?share=<shareId>
 *
 *   server → host:   {kind:'host-ready'}
 *                    {kind:'viewer-joined', viewerId}
 *                    {kind:'rtc-answer', shareId, viewerId, sdp}
 *                    {kind:'rtc-ice', shareId, viewerId, candidate, mid, from:'viewer'}
 *                    {kind:'presence', viewers:[{viewerId,name,role}]}
 *                    {kind:'chat', viewerId, name, role, text, ts}   (text = ciphertext)
 *   server → viewer: {kind:'assigned', viewerId}        (server-minted, unforgeable)
 *                    {kind:'rtc-offer', shareId, viewerId, sdp}
 *                    {kind:'rtc-ice', shareId, viewerId, candidate, mid, from:'host'}
 *                    {kind:'presence', viewers:[…]}
 *                    {kind:'chat', viewerId, name, role, text, ts}
 *   host → server:   {kind:'rtc-offer', viewerId, sdp}
 *                    {kind:'rtc-ice', viewerId, candidate, mid}
 *                    {kind:'hello', name}
 *                    {kind:'chat', text}                (text = ciphertext)
 *   viewer → server: {kind:'rtc-answer', sdp}
 *                    {kind:'rtc-ice', candidate, mid}
 *                    {kind:'hello', name}
 *                    {kind:'chat', text}
 *
 * The server is the identity authority: it mints viewerIds, stamps every
 * relayed frame with the connection's own (shareId, viewerId, from), and
 * drops anything that isn't one of these shapes — a client CANNOT speak for
 * another share, another viewer, or the other side. The host proves itself
 * with a host-secret it mints locally when the share is created; the server
 * binds the first secret it sees for a share and rejects later mismatches.
 *
 * Lifecycle: `watchShare` owns the host socket (the returned unwatch closes
 * it once the last watcher is gone); `announceViewer` owns a viewer socket
 * (closed when its last subscriber unsubscribes). Frames published while a
 * socket is still connecting are queued and flushed on open. No reconnect in
 * this slice — a dropped rendezvous socket is reported via `onError`; already
 * -established DataChannels are peer-to-peer and unaffected.
 */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type {
  ChatRelayFrame,
  JoinRequestFrame,
  PresenceEntry,
  PresenceFrame,
  RoleUpdateFrame,
} from '../presenceChat.js';
import { buildRoleUpdate } from '../presenceChat.js';
import type { SignalingChannel, SignalingFrame, SignalingSide } from './signaling.js';

export type { ChatRelayFrame, JoinRequestFrame, PresenceEntry, PresenceFrame, RoleUpdateFrame };

export interface WsSignalingOptions {
  /**
   * Base ws URL of the rendezvous, e.g. `wss://getvibe.dev/vibeshare` or
   * `ws://localhost:8787/vibeshare` for local `wrangler dev`.
   */
  readonly url: string;
  /** Socket errors and unexpected drops are reported here (default: ignored). */
  readonly onError?: (error: Error) => void;
  /** Multi-party presence roster updates (host socket). */
  readonly onPresence?: (frame: PresenceFrame) => void;
  /** Multi-party chat lines stamped by the rendezvous (host socket). */
  readonly onChat?: (frame: ChatRelayFrame) => void;
  /** Viewer requested to drive — identity hub-stamped (host socket). */
  readonly onJoinRequest?: (frame: JoinRequestFrame) => void;
}

interface HostConn {
  readonly shareId: string;
  readonly secret: string;
  readonly ws: WebSocket;
  open: boolean;
  closing: boolean;
  readonly outbox: string[];
  readonly watchers: Set<(viewerId: string) => void>;
  readonly hostSubs: Map<string, Set<(frame: SignalingFrame) => void>>;
  refs: number;
  /** Host display name announced via hello (default "host"). */
  name: string;
}

interface ViewerConn {
  readonly shareId: string;
  readonly localViewerId: string;
  readonly ws: WebSocket;
  open: boolean;
  closing: boolean;
  readonly outbox: string[];
  assignedViewerId: string | null;
  readonly viewerSubs: Set<(frame: SignalingFrame) => void>;
}

/** Cap on frames queued while a socket is connecting (abuse/bug backstop). */
const OUTBOX_CAP = 256;

export class WsSignaling implements SignalingChannel {
  readonly #base: string;
  readonly #onError: (error: Error) => void;
  readonly #onPresence: ((frame: PresenceFrame) => void) | undefined;
  readonly #onChat: ((frame: ChatRelayFrame) => void) | undefined;
  readonly #onJoinRequest: ((frame: JoinRequestFrame) => void) | undefined;
  readonly #hosts = new Map<string, HostConn>();
  readonly #viewers = new Map<string, ViewerConn>();
  /** Viewer-side subscribers registered before their announceViewer call. */
  readonly #pendingViewerSubs = new Map<string, Set<(frame: SignalingFrame) => void>>();

  constructor(opts: WsSignalingOptions) {
    this.#base = opts.url.replace(/\/+$/, '');
    this.#onError = opts.onError ?? (() => {});
    this.#onPresence = opts.onPresence;
    this.#onChat = opts.onChat;
    this.#onJoinRequest = opts.onJoinRequest;
  }

  /**
   * Announce the host display name on a share's host socket (hello frame).
   * Safe to call before or after watchShare — queued until the socket opens.
   */
  setHostName(shareId: string, name: string): void {
    const conn = this.#hostConn(shareId);
    conn.name = name.trim().length > 0 ? name.trim().slice(0, 32) : 'host';
    this.#send(conn, { kind: 'hello', name: conn.name });
  }

  /**
   * Send an e2e-encrypted chat ciphertext on the host socket. The rendezvous
   * stamps sender identity from the connection; `text` must already be
   * base64(encryptFrame(shareKey, utf8)) — the host client encrypts first.
   */
  sendChat(shareId: string, ciphertextB64: string): void {
    this.#sendHost(shareId, { kind: 'chat', text: ciphertextB64 });
  }

  /**
   * Host → one viewer: notify them of an approve/deny decision.
   * Hub only relays if this socket is the host for the share.
   */
  sendRoleUpdate(
    shareId: string,
    opts: { viewerId: string; role: 'spectator' | 'collaborator'; joinRequest: 'approved' | 'denied' | 'pending' | 'none' },
  ): void {
    const frame = buildRoleUpdate(opts);
    if (!frame) return;
    this.#sendHost(shareId, {
      kind: 'role-update',
      viewerId: frame.viewerId,
      role: frame.role,
      joinRequest: frame.joinRequest,
    });
  }

  // ------------------------------------------------------- SignalingChannel

  watchShare(shareId: string, onViewer: (viewerId: string) => void): () => void {
    const conn = this.#hostConn(shareId);
    conn.watchers.add(onViewer);
    conn.refs++;
    let unwatched = false;
    return () => {
      if (unwatched) return;
      unwatched = true;
      conn.watchers.delete(onViewer);
      conn.refs--;
      if (conn.refs <= 0) this.#closeHost(shareId);
    };
  }

  announceViewer(shareId: string, viewerId: string): void {
    const key = pairKey(shareId, viewerId);
    if (this.#viewers.has(key)) return;
    const ws = new WebSocket(`${this.#base}/ws/viewer?share=${encodeURIComponent(shareId)}`);
    const conn: ViewerConn = {
      shareId,
      localViewerId: viewerId,
      ws,
      open: false,
      closing: false,
      outbox: [],
      assignedViewerId: null,
      viewerSubs: new Set(),
    };
    this.#viewers.set(key, conn);
    // Subscribers that pre-registered for this pair move onto the live conn.
    const pending = this.#pendingViewerSubs.get(key);
    if (pending) {
      for (const h of pending) conn.viewerSubs.add(h);
      this.#pendingViewerSubs.delete(key);
    }
    ws.on('open', () => {
      conn.open = true;
      this.#flush(conn);
    });
    ws.on('message', (data: WebSocket.RawData) => this.#onViewerMessage(conn, String(data)));
    ws.on('error', (err: Error) => this.#onError(err));
    ws.on('close', () => {
      conn.open = false;
      if (!conn.closing) this.#onError(new Error(`signaling viewer socket for share ${shareId} closed`));
    });
  }

  subscribe(
    shareId: string,
    viewerId: string,
    side: SignalingSide,
    handler: (frame: SignalingFrame) => void,
  ): () => void {
    if (side === 'host') {
      const conn = this.#hostConn(shareId);
      let set = conn.hostSubs.get(viewerId);
      if (!set) {
        set = new Set();
        conn.hostSubs.set(viewerId, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) conn.hostSubs.delete(viewerId);
      };
    }
    const key = pairKey(shareId, viewerId);
    const conn = this.#viewers.get(key);
    if (conn) {
      conn.viewerSubs.add(handler);
      return () => {
        conn.viewerSubs.delete(handler);
        this.#closeViewerIfIdle(conn);
      };
    }
    let set = this.#pendingViewerSubs.get(key);
    if (!set) {
      set = new Set();
      this.#pendingViewerSubs.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#pendingViewerSubs.delete(key);
    };
  }

  publish(frame: SignalingFrame): void {
    switch (frame.kind) {
      case 'rtc-offer':
        this.#sendHost(frame.shareId, { kind: 'rtc-offer', viewerId: frame.viewerId, sdp: frame.sdp });
        return;
      case 'rtc-answer':
        this.#sendViewer(frame.shareId, frame.viewerId, { kind: 'rtc-answer', sdp: frame.sdp });
        return;
      case 'rtc-ice':
        if (frame.from === 'host') {
          this.#sendHost(frame.shareId, {
            kind: 'rtc-ice',
            viewerId: frame.viewerId,
            candidate: frame.candidate,
            mid: frame.mid,
          });
        } else {
          this.#sendViewer(frame.shareId, frame.viewerId, {
            kind: 'rtc-ice',
            candidate: frame.candidate,
            mid: frame.mid,
          });
        }
        return;
    }
  }

  // ------------------------------------------------------------- lifecycle

  /** Close every socket (host + viewer). Not part of the interface; for tests/teardown. */
  close(): void {
    for (const shareId of [...this.#hosts.keys()]) this.#closeHost(shareId);
    for (const conn of this.#viewers.values()) {
      conn.closing = true;
      try {
        conn.ws.close();
      } catch {
        // already closed
      }
    }
    this.#viewers.clear();
    this.#pendingViewerSubs.clear();
  }

  // ------------------------------------------------------------- internals

  #hostConn(shareId: string): HostConn {
    const existing = this.#hosts.get(shareId);
    if (existing) return existing;
    // The host-secret is minted here — when the share is created — held only
    // by the host process, and bound by the rendezvous on first sight.
    const secret = randomBytes(16).toString('hex');
    const ws = new WebSocket(
      `${this.#base}/ws/host?share=${encodeURIComponent(shareId)}&secret=${secret}`,
    );
    const conn: HostConn = {
      shareId,
      secret,
      ws,
      open: false,
      closing: false,
      outbox: [],
      watchers: new Set(),
      hostSubs: new Map(),
      refs: 0,
      name: 'host',
    };
    this.#hosts.set(shareId, conn);
    ws.on('open', () => {
      conn.open = true;
      this.#flush(conn);
      // Re-announce name after (re)connect so the roster includes the host label.
      this.#send(conn, { kind: 'hello', name: conn.name });
    });
    ws.on('message', (data: WebSocket.RawData) => this.#onHostMessage(conn, String(data)));
    ws.on('error', (err: Error) => this.#onError(err));
    ws.on('close', () => {
      conn.open = false;
      if (!conn.closing) this.#onError(new Error(`signaling host socket for share ${shareId} closed`));
    });
    return conn;
  }

  #closeHost(shareId: string): void {
    const conn = this.#hosts.get(shareId);
    if (!conn) return;
    this.#hosts.delete(shareId);
    conn.closing = true;
    conn.watchers.clear();
    conn.hostSubs.clear();
    try {
      conn.ws.close();
    } catch {
      // already closed
    }
  }

  #closeViewerIfIdle(conn: ViewerConn): void {
    if (conn.viewerSubs.size > 0) return;
    if (this.#viewers.get(pairKey(conn.shareId, conn.localViewerId)) !== conn) return;
    this.#viewers.delete(pairKey(conn.shareId, conn.localViewerId));
    conn.closing = true;
    try {
      conn.ws.close();
    } catch {
      // already closed
    }
  }

  #sendHost(shareId: string, msg: Record<string, unknown>): void {
    const conn = this.#hosts.get(shareId);
    if (!conn) return; // not watching this share — drop
    this.#send(conn, msg);
  }

  #sendViewer(shareId: string, viewerId: string, msg: Record<string, unknown>): void {
    const conn = this.#viewers.get(pairKey(shareId, viewerId));
    if (!conn) return; // not announced — drop
    this.#send(conn, msg);
  }

  #send(conn: HostConn | ViewerConn, msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    if (conn.open) {
      conn.ws.send(text);
    } else if (conn.outbox.length < OUTBOX_CAP) {
      conn.outbox.push(text);
    }
  }

  #flush(conn: HostConn | ViewerConn): void {
    for (const text of conn.outbox.splice(0)) conn.ws.send(text);
  }

  #onHostMessage(conn: HostConn, text: string): void {
    const msg = parseMessage(text);
    if (!msg) return;
    try {
      switch (msg['kind']) {
        case 'host-ready':
          return; // informational
        case 'viewer-joined': {
          if (typeof msg['viewerId'] !== 'string') return;
          for (const onViewer of conn.watchers) onViewer(msg['viewerId']);
          return;
        }
        case 'rtc-answer': {
          const frame = asAnswer(msg);
          if (!frame) return;
          this.#dispatchHost(conn, frame);
          return;
        }
        case 'rtc-ice': {
          const frame = asIce(msg, 'viewer');
          if (!frame) return;
          this.#dispatchHost(conn, frame);
          return;
        }
        case 'presence': {
          const frame = asPresence(msg);
          if (frame) this.#onPresence?.(frame);
          return;
        }
        case 'chat': {
          const frame = asChat(msg);
          if (frame) this.#onChat?.(frame);
          return;
        }
        case 'join-request': {
          const frame = asJoinRequest(msg);
          if (frame) this.#onJoinRequest?.(frame);
          return;
        }
        default:
          return; // unknown shape — ignore
      }
    } catch (err) {
      this.#onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onViewerMessage(conn: ViewerConn, text: string): void {
    const msg = parseMessage(text);
    if (!msg) return;
    try {
      switch (msg['kind']) {
        case 'assigned': {
          // The rendezvous ASSIGNS the viewerId — we never claim one.
          if (typeof msg['viewerId'] === 'string') conn.assignedViewerId = msg['viewerId'];
          return;
        }
        case 'rtc-offer': {
          const frame = asOffer(msg);
          if (!frame) return;
          for (const h of conn.viewerSubs) h(frame);
          return;
        }
        case 'rtc-ice': {
          const frame = asIce(msg, 'host');
          if (!frame) return;
          for (const h of conn.viewerSubs) h(frame);
          return;
        }
        case 'presence':
        case 'chat':
          // Viewer-side presence/chat is handled by the browser page over the
          // same socket; the Node viewer path (tests) ignores them here.
          return;
        default:
          return; // unknown shape — ignore
      }
    } catch (err) {
      this.#onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #dispatchHost(conn: HostConn, frame: SignalingFrame): void {
    for (const h of conn.hostSubs.get(frame.viewerId) ?? []) h(frame);
  }
}

function pairKey(shareId: string, viewerId: string): string {
  return `${shareId}/${viewerId}`;
}

function parseMessage(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asOffer(msg: Record<string, unknown>): SignalingFrame | null {
  const { kind, shareId, viewerId, sdp } = msg;
  if (kind !== 'rtc-offer' || typeof shareId !== 'string' || typeof viewerId !== 'string' || typeof sdp !== 'string') {
    return null;
  }
  return { kind: 'rtc-offer', shareId, viewerId, sdp };
}

function asAnswer(msg: Record<string, unknown>): SignalingFrame | null {
  const { kind, shareId, viewerId, sdp } = msg;
  if (kind !== 'rtc-answer' || typeof shareId !== 'string' || typeof viewerId !== 'string' || typeof sdp !== 'string') {
    return null;
  }
  return { kind: 'rtc-answer', shareId, viewerId, sdp };
}

function asIce(msg: Record<string, unknown>, from: SignalingSide): SignalingFrame | null {
  const { kind, shareId, viewerId, candidate, mid } = msg;
  if (
    kind !== 'rtc-ice' ||
    typeof shareId !== 'string' ||
    typeof viewerId !== 'string' ||
    typeof candidate !== 'string' ||
    typeof mid !== 'string'
  ) {
    return null;
  }
  return { kind: 'rtc-ice', shareId, viewerId, candidate, mid, from };
}

function asPresence(msg: Record<string, unknown>): PresenceFrame | null {
  if (msg['kind'] !== 'presence' || !Array.isArray(msg['viewers'])) return null;
  const viewers: PresenceEntry[] = [];
  for (const raw of msg['viewers']) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row['viewerId'] !== 'string' || typeof row['name'] !== 'string') continue;
    const role = row['role'] === 'host' ? 'host' : row['role'] === 'viewer' ? 'viewer' : null;
    if (!role) continue;
    viewers.push({ viewerId: row['viewerId'], name: row['name'], role });
  }
  return { kind: 'presence', viewers };
}

function asChat(msg: Record<string, unknown>): ChatRelayFrame | null {
  if (msg['kind'] !== 'chat') return null;
  if (typeof msg['viewerId'] !== 'string') return null;
  if (typeof msg['name'] !== 'string') return null;
  if (typeof msg['text'] !== 'string') return null;
  const role = msg['role'] === 'host' ? 'host' : msg['role'] === 'viewer' ? 'viewer' : null;
  if (!role) return null;
  const ts = typeof msg['ts'] === 'number' ? msg['ts'] : Date.now();
  return {
    kind: 'chat',
    viewerId: msg['viewerId'],
    name: msg['name'],
    role,
    text: msg['text'],
    ts,
  };
}

function asJoinRequest(msg: Record<string, unknown>): JoinRequestFrame | null {
  if (msg['kind'] !== 'join-request') return null;
  if (typeof msg['viewerId'] !== 'string' || msg['viewerId'].length === 0) return null;
  if (typeof msg['name'] !== 'string') return null;
  return { kind: 'join-request', viewerId: msg['viewerId'], name: msg['name'] };
}

