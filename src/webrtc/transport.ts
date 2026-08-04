/**
 * WebRtcTransport — pure peer-to-peer `ShareTransport` (host side).
 *
 * Session bytes flow host→viewer directly over a WebRTC DataChannel
 * (node-datachannel / libdatachannel); no server relays them. The only
 * third party is the `SignalingChannel` rendezvous, which carries the
 * offer/answer/ICE handshake — and it never sees plaintext:
 *
 *   - a fresh 256-bit key is generated per share (node crypto),
 *   - every DataChannel frame is AES-256-GCM encrypted with a fresh
 *     12-byte nonce — wire format `nonce(12) ‖ ciphertext ‖ tag(16)`,
 *   - the key travels ONLY in the share URL `#fragment`, which is never
 *     sent through signaling (URL fragments never leave the client).
 *
 * Inbound is the collaborator-input half of the vibelive seam: a viewer's
 * input frame is decrypted, authenticated, and then gated on
 * `ViewerRegistry.canWrite()` — a spectator's input is dropped silently;
 * only an approved collaborator's input reaches `onInput`. Anything that
 * fails GCM authentication is dropped before it can yield plaintext.
 */
import { randomBytes } from 'node:crypto';
import { PeerConnection, type DataChannel } from 'node-datachannel';

/**
 * Backlog flow control. A transcript (or long session) backlog can be many MB;
 * blasting it all into the DataChannel at open overflows SCTP send buffers and
 * stalls the handshake. Pace it: stop feeding new frames once `bufferedAmount`
 * crosses HIGH, resume when it drains below LOW.
 */
const FLUSH_HIGH_WATER = 512 * 1024;
const FLUSH_LOW_WATER = 64 * 1024;
import { decryptFrame, encryptFrame, E2E_KEY_LEN } from '@pooriaarab/vibe-core';
import type { SessionFeed } from '@pooriaarab/vibe-core/feed';
import type { ViewerRegistry } from '../registry.js';
import type { ShareTransport } from '../transport.js';
import type { FeedEntry, Share, Viewer } from '../types.js';
import type { SignalingChannel } from './signaling.js';

/** Re-export the shared e2e wire format so slice-1 imports keep working. */
export { decryptFrame, encryptFrame } from '@pooriaarab/vibe-core';

/** Default base for share URLs — the public viewer page host. */
const DEFAULT_BASE_URL = 'https://getvibe.dev/vibeshare';

/** A collaborator input frame (viewer → host), decrypted from a DataChannel message. */
export interface ViewerInputFrame {
  readonly kind: 'input';
  /** UTF-8 input the collaborator wants applied to the session. */
  readonly data: string;
  /**
   * Per-peer monotonic sequence number. The host rejects any input frame
   * whose seq is ≤ the last one accepted from that peer, so a captured
   * ciphertext replayed on the same DataChannel is dropped, not re-applied.
   */
  readonly seq: number;
}

export interface WebRtcTransportOptions {
  /** The rendezvous used for the offer/answer/ICE handshake. */
  readonly signaling: SignalingChannel;
  /**
   * STUN/TURN servers for ICE. Default `[]` — host candidates only, which
   * is enough for loopback/LAN peers and keeps tests fully local.
   */
  readonly iceServers?: string[];
  /** Base URL for share links. Default `https://getvibe.dev/vibeshare`. */
  readonly baseUrl?: string;
  /**
   * Where gated collaborator input is delivered. Called only for frames
   * that decrypted, authenticated, parsed, AND passed `canWrite()`.
   */
  readonly onInput?: (shareId: string, viewerId: string, data: string) => void;
}

interface PeerContext {
  readonly pc: PeerConnection;
  readonly dc: DataChannel;
  unsubscribeSignaling: () => void;
  unsubscribeFeed: (() => void) | null;
  /**
   * Live entries buffered between feed subscribe and channel open, and again
   * while the backlog is being paced out (see `flushing`) so a live entry can
   * never jump ahead of unfinished backlog.
   */
  pending: FeedEntry[];
  open: boolean;
  /** True while the initial backlog is still being paced onto the channel. */
  flushing: boolean;
  /** Last accepted collaborator-input seq (anti-replay watermark). */
  lastInputSeq: number;
}

interface ShareContext {
  readonly share: Share;
  readonly feed: SessionFeed;
  readonly viewers: ViewerRegistry;
  readonly key: Buffer;
  readonly peers: Map<string, PeerContext>;
  unwatch: () => void;
  /** Remove the registry (kick/leave) + feed-close listeners on teardown. */
  detach: () => void;
}

export class WebRtcTransport implements ShareTransport {
  readonly kind = 'webrtc';

  readonly #signaling: SignalingChannel;
  readonly #iceServers: string[];
  readonly #baseUrl: string;
  readonly #onInput: ((shareId: string, viewerId: string, data: string) => void) | undefined;
  readonly #shares = new Map<string, ShareContext>();

  constructor(opts: WebRtcTransportOptions) {
    this.#signaling = opts.signaling;
    this.#iceServers = opts.iceServers ?? [];
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#onInput = opts.onInput;
  }

  async serve(share: Share, feed: SessionFeed, viewers: ViewerRegistry): Promise<string> {
    if (this.#shares.has(share.id)) {
      // A second serve would orphan the first share's peers + listeners.
      throw new Error(`share ${share.id} is already being served`);
    }
    const key = randomBytes(E2E_KEY_LEN);
    const ctx: ShareContext = {
      share,
      feed,
      viewers,
      key,
      peers: new Map(),
      unwatch: () => {},
      detach: () => {},
    };
    ctx.unwatch = this.#signaling.watchShare(share.id, (viewerId) => this.#acceptViewer(ctx, viewerId));

    // A kicked or departed viewer must lose the DATA plane, not just input.
    // canWrite() already blocks their input, but the session keeps streaming
    // to their DataChannel until the peer is dropped — mirror the
    // LocalHttpTransport contract that kick/leave close a viewer's streams.
    const dropOnRemoval = (v: Viewer): void => this.#dropPeer(ctx, v.id);
    const onFeedClose = (): void => void this.unserve(share.id);
    viewers.on('kick', dropOnRemoval);
    viewers.on('leave', dropOnRemoval);
    feed.on('close', onFeedClose);
    ctx.detach = () => {
      viewers.off('kick', dropOnRemoval);
      viewers.off('leave', dropOnRemoval);
      feed.off('close', onFeedClose);
    };

    this.#shares.set(share.id, ctx);
    return `${this.#baseUrl}/s/${share.id}#${key.toString('base64url')}`;
  }

  async unserve(shareId: string): Promise<void> {
    const ctx = this.#shares.get(shareId);
    if (!ctx) return;
    this.#shares.delete(shareId);
    ctx.unwatch();
    ctx.detach();
    for (const peer of ctx.peers.values()) this.#closePeer(peer);
    ctx.peers.clear();
  }

  async close(): Promise<void> {
    for (const shareId of [...this.#shares.keys()]) await this.unserve(shareId);
  }

  /** Number of shares currently served (diagnostics/tests). */
  get shareCount(): number {
    return this.#shares.size;
  }

  /** Live peer connections for one share (diagnostics/tests). */
  peerCount(shareId: string): number {
    return this.#shares.get(shareId)?.peers.size ?? 0;
  }

  // ------------------------------------------------------------- peers

  /** A viewer announced itself: open a peer connection and publish an offer. */
  #acceptViewer(ctx: ShareContext, viewerId: string): void {
    if (!this.#shares.has(ctx.share.id)) return; // unserved in the meantime
    if (ctx.peers.has(viewerId)) return; // duplicate announce

    const pc = new PeerConnection(`vibeshare-${ctx.share.id}`, { iceServers: this.#iceServers });

    // Wiring order matters with a synchronous signaling channel:
    //  1. libdatachannel will not queue remote candidates that arrive
    //     before the remote description — hold them until the answer lands.
    //  2. The answer/ice subscription must be installed BEFORE any offer
    //     can be published, or a synchronous answer is published to nobody.
    //  3. libdatachannel can generate the local description synchronously
    //     inside createDataChannel, so onLocalDescription must be
    //     registered before that call (localDescription() covers it too).
    let remoteDescSet = false;
    const queuedCandidates: Array<{ candidate: string; mid: string }> = [];
    const unsubscribeSignaling = this.#signaling.subscribe(ctx.share.id, viewerId, 'host', (frame) => {
      try {
        if (frame.kind === 'rtc-answer') {
          pc.setRemoteDescription(frame.sdp, 'answer');
          remoteDescSet = true;
          for (const c of queuedCandidates) pc.addRemoteCandidate(c.candidate, c.mid);
          queuedCandidates.length = 0;
        } else if (frame.kind === 'rtc-ice') {
          if (remoteDescSet) pc.addRemoteCandidate(frame.candidate, frame.mid);
          else queuedCandidates.push(frame);
        }
      } catch {
        // Peer torn down mid-handshake — dropPeer owns the cleanup.
      }
    });

    let offerPublished = false;
    const publishOffer = (sdp: string): void => {
      if (offerPublished) return;
      offerPublished = true;
      this.#signaling.publish({ kind: 'rtc-offer', shareId: ctx.share.id, viewerId, sdp });
    };
    pc.onLocalDescription((sdp) => publishOffer(sdp));
    pc.onLocalCandidate((candidate, mid) => {
      if (candidate === '') return; // end-of-gathering marker, not a candidate
      this.#signaling.publish({ kind: 'rtc-ice', shareId: ctx.share.id, viewerId, candidate, mid, from: 'host' });
    });

    const dc = pc.createDataChannel('feed');
    const local = pc.localDescription();
    if (local) publishOffer(local.sdp);

    const peer: PeerContext = {
      pc,
      dc,
      unsubscribeSignaling,
      unsubscribeFeed: null,
      pending: [],
      open: false,
      flushing: false,
      lastInputSeq: -1,
    };
    ctx.peers.set(viewerId, peer);
    // Fire onBufferedAmountLow once the send buffer drains below this, so the
    // paced flush can resume without busy-waiting.
    dc.setBufferedAmountLowThreshold(FLUSH_LOW_WATER);

    // Subscribe now and buffer until the channel opens: replaying the
    // backlog only at open time would silently drop entries published
    // during the handshake.
    // Subscribe BEFORE snapshotting the backlog: an entry published during
    // the handshake then lands in `pending` instead of the gap between the
    // two calls. The two can overlap (an entry in both) — dedup by seq.
    peer.unsubscribeFeed = ctx.feed.subscribe((entry) => {
      // Send directly only once the channel is open AND the backlog flush has
      // finished; otherwise queue so ordering is preserved.
      if (peer.open && !peer.flushing) this.#sendEntry(ctx, peer, entry);
      else peer.pending.push(entry);
    });
    const backlog = [...ctx.feed.backlog()];

    dc.onOpen(() => {
      peer.open = true;
      void this.#flushBacklog(ctx, peer, backlog);
    });
    dc.onMessage((msg) => this.#handleInbound(ctx, viewerId, msg));
    dc.onClosed(() => this.#dropPeer(ctx, viewerId));
    pc.onStateChange((state) => {
      // `disconnected` is often a transient ICE blip that recovers; only a
      // terminal state tears the peer down. (Real reconnect/backoff is a
      // later hardening — ponytail: drop on terminal states, revisit if
      // flaky loopback/LAN peers need a grace window.)
      if (state === 'failed' || state === 'closed') {
        this.#dropPeer(ctx, viewerId);
      }
    });
  }

  #dropPeer(ctx: ShareContext, viewerId: string): void {
    const peer = ctx.peers.get(viewerId);
    if (!peer) return;
    ctx.peers.delete(viewerId);
    this.#closePeer(peer);
  }

  #closePeer(peer: PeerContext): void {
    peer.unsubscribeSignaling();
    peer.unsubscribeFeed?.();
    peer.unsubscribeFeed = null;
    try {
      peer.dc.close();
    } catch {
      // already closed
    }
    try {
      peer.pc.close();
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------- frames

  /**
   * Pace the initial backlog onto a freshly-opened channel, then drain anything
   * that queued during the flush, then hand off to direct live sends. Live
   * entries stay in `peer.pending` (guarded by `peer.flushing`) until this
   * completes, so nothing jumps ahead of the backlog. Deduped by seq because an
   * entry published during the handshake can appear in both backlog and pending.
   */
  async #flushBacklog(ctx: ShareContext, peer: PeerContext, backlog: FeedEntry[]): Promise<void> {
    peer.flushing = true;
    const sent = new Set<number>();
    const sendPaced = async (entry: FeedEntry): Promise<void> => {
      await this.#drain(peer);
      if (!peer.open || sent.has(entry.seq)) return;
      this.#sendEntry(ctx, peer, entry);
      sent.add(entry.seq);
    };
    for (const entry of backlog) {
      if (!peer.open) return;
      await sendPaced(entry);
    }
    // Entries that arrived during the (awaited) backlog send accumulated in
    // pending; drain them the same paced way. New arrivals keep landing in
    // pending while flushing is true, so loop until it's empty.
    while (peer.open && peer.pending.length > 0) {
      const batch = peer.pending;
      peer.pending = [];
      for (const entry of batch) {
        if (!peer.open) return;
        await sendPaced(entry);
      }
    }
    // No awaits between the emptiness check above and this flag flip, so no live
    // entry can slip into the gap — the subscription now sends directly, in order.
    peer.flushing = false;
  }

  /** Resolve once the send buffer is below HIGH (immediately if already low). */
  #drain(peer: PeerContext): Promise<void> {
    if (!peer.open || peer.dc.bufferedAmount() < FLUSH_HIGH_WATER) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve();
      };
      peer.dc.onBufferedAmountLow(finish);
      // Poll fallback: onBufferedAmountLow can miss if the buffer never dips to
      // exactly the threshold, or the peer dies mid-flush.
      const timer = setInterval(() => {
        if (!peer.open || peer.dc.bufferedAmount() < FLUSH_HIGH_WATER) finish();
      }, 50);
      timer.unref?.();
    });
  }

  #sendEntry(ctx: ShareContext, peer: PeerContext, entry: FeedEntry): void {
    try {
      peer.dc.sendMessageBinary(encryptFrame(ctx.key, Buffer.from(JSON.stringify(entry), 'utf8')));
    } catch {
      // Channel closing mid-send; the close path tears the peer down.
    }
  }

  /**
   * Inbound collaborator input. Decrypt + authenticate first (failures are
   * dropped silently — no plaintext, no error surface), then the anti-replay
   * watermark (a replayed or out-of-order ciphertext never reaches the gate),
   * then the write-arbitration gate: only `canWrite()` viewers reach `onInput`.
   */
  #handleInbound(ctx: ShareContext, viewerId: string, msg: string | Buffer | ArrayBuffer): void {
    let plaintext: Buffer;
    try {
      const frame =
        typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg instanceof ArrayBuffer ? Buffer.from(msg) : msg;
      plaintext = decryptFrame(ctx.key, frame);
    } catch {
      return; // tampered or malformed frame
    }
    let input: unknown;
    try {
      input = JSON.parse(plaintext.toString('utf8'));
    } catch {
      return; // not an input frame
    }
    if (typeof input !== 'object' || input === null) return;
    const { kind, data, seq } = input as Record<string, unknown>;
    if (kind !== 'input' || typeof data !== 'string') return;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return; // seq is mandatory
    const peer = ctx.peers.get(viewerId);
    if (!peer) return; // peer already torn down
    // Anti-replay: drop a re-sent or out-of-order frame BEFORE any gating
    // side effects. DataChannels are ordered, so a legit peer's seq only ever
    // advances; anything ≤ the watermark is a replay (or a stale duplicate).
    if (seq <= peer.lastInputSeq) return;
    peer.lastInputSeq = seq;
    if (!ctx.viewers.canWrite(viewerId)) return; // spectator — drop silently
    this.#onInput?.(ctx.share.id, viewerId, data);
  }
}
