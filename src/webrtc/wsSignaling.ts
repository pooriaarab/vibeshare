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
 *                    {kind:'annotation', id, seq, viewerId, name, role, text, replyTo?, ts}   (text = ciphertext)
 *   server → viewer: {kind:'assigned', viewerId}        (server-minted, unforgeable)
 *                    {kind:'rtc-offer', shareId, viewerId, sdp}
 *                    {kind:'rtc-ice', shareId, viewerId, candidate, mid, from:'host'}
 *                    {kind:'rtc-ice-servers', shareId, viewerId, iceServers}   (host's STUN/TURN config)
 *                    {kind:'presence', viewers:[…]}
 *                    {kind:'chat', viewerId, name, role, text, ts}
 *   host → server:   {kind:'rtc-offer', viewerId, sdp}
 *                    {kind:'rtc-ice', viewerId, candidate, mid}
 *                    {kind:'rtc-ice-servers', viewerId, iceServers}
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
import type { AnnotationRelayFrame } from '../annotations.js';
import type {
  ChatRelayFrame,
  JoinRequestFrame,
  PresenceEntry,
  PresenceFrame,
  RoleUpdateFrame,
} from '../presenceChat.js';
import { buildRoleUpdate } from '../presenceChat.js';
import type { SignalingChannel, SignalingFrame, SignalingSide } from './signaling.js';
import {
  pairKey,
  parseMessage,
  asOffer,
  asIceServers,
  asAnswer,
  asIce,
  asPresence,
  asChat,
  asJoinRequest,
  asAnnotation,
} from './wsSignalingValidation.js';
import { WsConnectionManager } from './wsSignalingConnection.js';
import type { HostConn, ViewerConn } from './wsSignalingConnection.js';

export type { AnnotationRelayFrame };
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
  /** Multi-party annotations stamped by the rendezvous (host socket). */
  readonly onAnnotation?: (frame: AnnotationRelayFrame) => void;
  /** Viewer requested to drive — identity hub-stamped (host socket). */
  readonly onJoinRequest?: (frame: JoinRequestFrame) => void;
}

export class WsSignaling implements SignalingChannel {
  readonly #onError: (error: Error) => void;
  readonly #onPresence: ((frame: PresenceFrame) => void) | undefined;
  readonly #onChat: ((frame: ChatRelayFrame) => void) | undefined;
  readonly #onAnnotation: ((frame: AnnotationRelayFrame) => void) | undefined;
  readonly #onJoinRequest: ((frame: JoinRequestFrame) => void) | undefined;
  readonly #connMgr: WsConnectionManager;
  /** Viewer-side subscribers registered before their announceViewer call. */
  readonly #pendingViewerSubs = new Map<string, Set<(frame: SignalingFrame) => void>>();

  readonly #hostHandlers: Record<string, ((conn: HostConn, msg: Record<string, unknown>) => void) | undefined> = {
    'host-ready': () => {}, // informational
    'viewer-joined': (conn, msg) => {
      if (typeof msg['viewerId'] !== 'string') return;
      for (const onViewer of conn.watchers) onViewer(msg['viewerId']);
    },
    'rtc-answer': (conn, msg) => {
      const frame = asAnswer(msg);
      if (frame) this.#dispatchHost(conn, frame);
    },
    'rtc-ice': (conn, msg) => {
      const frame = asIce(msg, 'viewer');
      if (frame) this.#dispatchHost(conn, frame);
    },
    'presence': (_conn, msg) => {
      const frame = asPresence(msg);
      if (frame) this.#onPresence?.(frame);
    },
    'chat': (_conn, msg) => {
      const frame = asChat(msg);
      if (frame) this.#onChat?.(frame);
    },
    'annotation': (_conn, msg) => {
      const frame = asAnnotation(msg);
      if (frame) this.#onAnnotation?.(frame);
    },
    'join-request': (_conn, msg) => {
      const frame = asJoinRequest(msg);
      if (frame) this.#onJoinRequest?.(frame);
    },
  };

  readonly #viewerHandlers: Record<string, ((conn: ViewerConn, msg: Record<string, unknown>) => void) | undefined> = {
    'assigned': (conn, msg) => {
      // The rendezvous ASSIGNS the viewerId — we never claim one.
      if (typeof msg['viewerId'] === 'string') {
        conn.assignedViewerId = msg['viewerId'];
      }
    },
    'rtc-offer': (conn, msg) => {
      const frame = asOffer(msg);
      if (frame) {
        for (const h of conn.viewerSubs) h(frame);
      }
    },
    'rtc-ice-servers': (conn, msg) => {
      const frame = asIceServers(msg);
      if (frame) {
        for (const h of conn.viewerSubs) h(frame);
      }
    },
    'rtc-ice': (conn, msg) => {
      const frame = asIce(msg, 'host');
      if (frame) {
        for (const h of conn.viewerSubs) h(frame);
      }
    },
    // Viewer-side presence/chat/annotations are handled by the browser page
    // over the same socket; the Node viewer path (tests) ignores them here.
    // They stay in the table so the accepted-kind set matches the host side's
    // documented whitelist rather than falling through to the drop branch.
    'presence': () => {},
    'chat': () => {},
    'annotation': () => {},
  };

  constructor(opts: WsSignalingOptions) {
    this.#onError = opts.onError ?? (() => {});
    this.#onPresence = opts.onPresence;
    this.#onChat = opts.onChat;
    this.#onAnnotation = opts.onAnnotation;
    this.#onJoinRequest = opts.onJoinRequest;
    this.#connMgr = new WsConnectionManager(
      opts.url.replace(/\/+$/, ''),
      this.#onError,
      (conn, text) => this.#onHostMessage(conn, text),
      (conn, text) => this.#onViewerMessage(conn, text),
    );
  }

  /**
   * Announce the host display name on a share's host socket (hello frame).
   * Safe to call before or after watchShare — queued until the socket opens.
   */
  setHostName(shareId: string, name: string): void {
    const conn = this.#connMgr.hostConn(shareId);
    conn.name = name.trim().length > 0 ? name.trim().slice(0, 32) : 'host';
    this.#connMgr.send(conn, { kind: 'hello', name: conn.name });
  }

  /**
   * Send an e2e-encrypted chat ciphertext on the host socket. The rendezvous
   * stamps sender identity from the connection; `text` must already be
   * base64(encryptFrame(shareKey, utf8)) — the host client encrypts first.
   */
  sendChat(shareId: string, ciphertextB64: string): void {
    this.#connMgr.sendHost(shareId, { kind: 'chat', text: ciphertextB64 });
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
    this.#connMgr.sendHost(shareId, {
      kind: 'role-update',
      viewerId: frame.viewerId,
      role: frame.role,
      joinRequest: frame.joinRequest,
    });
  }

  // ------------------------------------------------------- SignalingChannel

  watchShare(shareId: string, onViewer: (viewerId: string) => void): () => void {
    const conn = this.#connMgr.hostConn(shareId);
    conn.watchers.add(onViewer);
    conn.refs++;
    let unwatched = false;
    return () => {
      if (unwatched) return;
      unwatched = true;
      conn.watchers.delete(onViewer);
      conn.refs--;
      if (conn.refs <= 0) this.#connMgr.closeHost(shareId);
    };
  }

  announceViewer(shareId: string, viewerId: string): void {
    const key = pairKey(shareId, viewerId);
    if (this.#connMgr.viewers.has(key)) return;
    const conn = this.#connMgr.viewerConn(shareId, viewerId);
    // Subscribers that pre-registered for this pair move onto the live conn.
    const pending = this.#pendingViewerSubs.get(key);
    if (pending) {
      for (const h of pending) conn.viewerSubs.add(h);
      this.#pendingViewerSubs.delete(key);
    }
  }

  subscribe(
    shareId: string,
    viewerId: string,
    side: SignalingSide,
    handler: (frame: SignalingFrame) => void,
  ): () => void {
    if (side === 'host') {
      const conn = this.#connMgr.hostConn(shareId);
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
    const conn = this.#connMgr.viewers.get(key);
    if (conn) {
      conn.viewerSubs.add(handler);
      return () => {
        conn.viewerSubs.delete(handler);
        this.#connMgr.closeViewerIfIdle(conn);
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
        this.#connMgr.sendHost(frame.shareId, { kind: 'rtc-offer', viewerId: frame.viewerId, sdp: frame.sdp });
        return;
      case 'rtc-answer':
        this.#connMgr.sendViewer(frame.shareId, frame.viewerId, { kind: 'rtc-answer', sdp: frame.sdp });
        return;
      case 'rtc-ice-servers':
        this.#connMgr.sendHost(frame.shareId, {
          kind: 'rtc-ice-servers',
          viewerId: frame.viewerId,
          iceServers: frame.iceServers,
        });
        return;
      case 'rtc-ice':
        if (frame.from === 'host') {
          this.#connMgr.sendHost(frame.shareId, {
            kind: 'rtc-ice',
            viewerId: frame.viewerId,
            candidate: frame.candidate,
            mid: frame.mid,
          });
        } else {
          this.#connMgr.sendViewer(frame.shareId, frame.viewerId, {
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
    this.#connMgr.close();
    this.#pendingViewerSubs.clear();
  }

  // ------------------------------------------------------------- internals

  #onHostMessage(conn: HostConn, text: string): void {
    const msg = parseMessage(text);
    if (!msg) return;
    try {
      const kind = msg['kind'];
      if (typeof kind !== 'string') return;
      const handler = Object.hasOwn(this.#hostHandlers, kind) ? this.#hostHandlers[kind] : undefined;
      if (handler) {
        handler(conn, msg);
      }
    } catch (err) {
      this.#onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onViewerMessage(conn: ViewerConn, text: string): void {
    const msg = parseMessage(text);
    if (!msg) return;
    try {
      const kind = msg['kind'];
      if (typeof kind !== 'string') return;
      const handler = Object.hasOwn(this.#viewerHandlers, kind) ? this.#viewerHandlers[kind] : undefined;
      if (handler) {
        handler(conn, msg);
      }
    } catch (err) {
      this.#onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #dispatchHost(conn: HostConn, frame: SignalingFrame): void {
    for (const h of conn.hostSubs.get(frame.viewerId) ?? []) h(frame);
  }
}
