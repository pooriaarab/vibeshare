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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PeerConnection, type DataChannel } from 'node-datachannel';
import type { SessionFeed } from '../feed.js';
import type { ViewerRegistry } from '../registry.js';
import type { ShareTransport } from '../transport.js';
import type { FeedEntry, Share, Viewer } from '../types.js';
import type { SignalingChannel } from './signaling.js';

const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Default base for share URLs — the public viewer page host. */
const DEFAULT_BASE_URL = 'https://getvibe.dev/vibeshare';

/**
 * Encrypt one DataChannel frame: `nonce ‖ ciphertext ‖ GCM tag`, with a
 * fresh random nonce per frame. Exported so viewer-side code (and tests)
 * share exactly one wire format.
 */
export function encryptFrame(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Decrypt one DataChannel frame. Throws on truncation, a wrong key, or any
 * tampering — GCM authentication failure yields no plaintext, ever.
 */
export function decryptFrame(key: Buffer, frame: Buffer): Buffer {
  if (frame.length < NONCE_LEN + TAG_LEN) throw new Error('webrtc frame too short');
  const nonce = frame.subarray(0, NONCE_LEN);
  const ciphertext = frame.subarray(NONCE_LEN, frame.length - TAG_LEN);
  const tag = frame.subarray(frame.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** A collaborator input frame (viewer → host), decrypted from a DataChannel message. */
export interface ViewerInputFrame {
  readonly kind: 'input';
  /** UTF-8 input the collaborator wants applied to the session. */
  readonly data: string;
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
  /** Live entries buffered between feed subscribe and channel open. */
  pending: FeedEntry[];
  open: boolean;
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
    const key = randomBytes(KEY_LEN);
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
    };
    ctx.peers.set(viewerId, peer);

    // Subscribe now and buffer until the channel opens: replaying the
    // backlog only at open time would silently drop entries published
    // during the handshake.
    // Subscribe BEFORE snapshotting the backlog: an entry published during
    // the handshake then lands in `pending` instead of the gap between the
    // two calls. The two can overlap (an entry in both) — dedup by seq.
    peer.unsubscribeFeed = ctx.feed.subscribe((entry) => {
      if (peer.open) this.#sendEntry(ctx, peer, entry);
      else peer.pending.push(entry);
    });
    const backlog = [...ctx.feed.backlog()];

    dc.onOpen(() => {
      peer.open = true;
      const sent = new Set<number>();
      for (const entry of backlog) {
        this.#sendEntry(ctx, peer, entry);
        sent.add(entry.seq);
      }
      for (const entry of peer.pending) {
        if (!sent.has(entry.seq)) this.#sendEntry(ctx, peer, entry);
      }
      peer.pending = [];
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

  #sendEntry(ctx: ShareContext, peer: PeerContext, entry: FeedEntry): void {
    try {
      peer.dc.sendMessageBinary(encryptFrame(ctx.key, Buffer.from(JSON.stringify(entry), 'utf8')));
    } catch {
      // Channel closing mid-send; the close path tears the peer down.
    }
  }

  /**
   * Inbound collaborator input. Decrypt + authenticate first (failures are
   * dropped silently — no plaintext, no error surface), then the
   * write-arbitration gate: only `canWrite()` viewers reach `onInput`.
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
    const { kind, data } = input as Record<string, unknown>;
    if (kind !== 'input' || typeof data !== 'string') return;
    if (!ctx.viewers.canWrite(viewerId)) return; // spectator — drop silently
    this.#onInput?.(ctx.share.id, viewerId, data);
  }
}
