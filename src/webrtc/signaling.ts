/**
 * SignalingChannel — the rendezvous seam for `WebRtcTransport`.
 *
 * WebRTC peers cannot connect cold: they must first exchange an SDP
 * offer/answer pair and trickle ICE candidates. That handshake is the ONLY
 * traffic allowed through a rendezvous — the session bytes themselves flow
 * peer-to-peer over the DataChannel, AES-256-GCM encrypted, so the
 * rendezvous never sees plaintext (the key never crosses this channel; it
 * lives only in the share URL fragment).
 *
 * Everything is keyed by `shareId + viewerId`: the host watches a share,
 * a viewer announces itself, the host publishes one offer per viewer, the
 * viewer answers, and both sides trickle ICE. The frame shape mirrors the
 * `rtc-offer` / `rtc-answer` / `rtc-ice` messages used elsewhere in the
 * Vibe Suite.
 *
 * The interface is deliberately minimal and transport-agnostic: a real
 * implementation over a Worker/WebSocket lands later. `LoopbackSignaling`
 * below is the in-process implementation used to connect two peers inside
 * one test process.
 */

import type { RTCIceServer } from '../config.js';

/** Which end of a share/viewer pair a signaling participant sits on. */
export type SignalingSide = 'host' | 'viewer';

/** Host → viewer: SDP offer for a new peer connection. */
export interface RtcOfferFrame {
  readonly kind: 'rtc-offer';
  readonly shareId: string;
  readonly viewerId: string;
  readonly sdp: string;
}

/** Viewer → host: SDP answer to the host's offer. */
export interface RtcAnswerFrame {
  readonly kind: 'rtc-answer';
  readonly shareId: string;
  readonly viewerId: string;
  readonly sdp: string;
}

/** Both ways: one trickled ICE candidate. `from` marks the sending side. */
export interface RtcIceFrame {
  readonly kind: 'rtc-ice';
  readonly shareId: string;
  readonly viewerId: string;
  readonly candidate: string;
  readonly mid: string;
  readonly from: SignalingSide;
}

/**
 * Host → viewer ONLY: the host's ICE server list (STUN/TURN, credentials
 * included), sent right after a viewer is announced and BEFORE the offer, so
 * the viewer builds its RTCPeerConnection with the same TURN config — BYO
 * TURN on the host just works for browser viewers. A viewer that never
 * receives this frame falls back to its built-in STUN default.
 */
export interface RtcIceServersFrame {
  readonly kind: 'rtc-ice-servers';
  readonly shareId: string;
  readonly viewerId: string;
  readonly iceServers: readonly RTCIceServer[];
}

export type SignalingFrame = RtcOfferFrame | RtcAnswerFrame | RtcIceFrame | RtcIceServersFrame;

/**
 * A rendezvous for WebRTC handshakes. Delivery is point-to-point per
 * share/viewer pair: a published frame reaches only the subscribers on the
 * OPPOSITE side of that pair. Implementations may deliver asynchronously;
 * frames for one pair must arrive in publish order.
 */
export interface SignalingChannel {
  /**
   * Host side: be notified each time a viewer announces itself on a share.
   * Returns an unwatch function (idempotent teardown is the caller's job).
   */
  watchShare(shareId: string, onViewer: (viewerId: string) => void): () => void;

  /** Viewer side: announce presence on a share so the host publishes an offer. */
  announceViewer(shareId: string, viewerId: string): void;

  /**
   * Subscribe to frames for one share/viewer pair addressed to `side`
   * (i.e. sent by the opposite side). Returns an unsubscribe function.
   */
  subscribe(
    shareId: string,
    viewerId: string,
    side: SignalingSide,
    handler: (frame: SignalingFrame) => void,
  ): () => void;

  /** Publish a frame; it is delivered to the opposite side of the pair. */
  publish(frame: SignalingFrame): void;
}

interface PairSubscribers {
  readonly host: Set<(frame: SignalingFrame) => void>;
  readonly viewer: Set<(frame: SignalingFrame) => void>;
}

/**
 * In-process SignalingChannel: host and viewer peers living in the same
 * process (a test, a demo) find each other through shared Maps. Delivery is
 * synchronous and ordered. No timers, no sockets — nothing leaves the
 * process.
 */
export class LoopbackSignaling implements SignalingChannel {
  readonly #watchers = new Map<string, Set<(viewerId: string) => void>>();
  readonly #pairs = new Map<string, PairSubscribers>();

  watchShare(shareId: string, onViewer: (viewerId: string) => void): () => void {
    let set = this.#watchers.get(shareId);
    if (!set) {
      set = new Set();
      this.#watchers.set(shareId, set);
    }
    set.add(onViewer);
    return () => {
      set.delete(onViewer);
      if (set.size === 0) this.#watchers.delete(shareId);
    };
  }

  announceViewer(shareId: string, viewerId: string): void {
    for (const onViewer of this.#watchers.get(shareId) ?? []) onViewer(viewerId);
  }

  subscribe(
    shareId: string,
    viewerId: string,
    side: SignalingSide,
    handler: (frame: SignalingFrame) => void,
  ): () => void {
    const key = pairKey(shareId, viewerId);
    let pair = this.#pairs.get(key);
    if (!pair) {
      pair = { host: new Set(), viewer: new Set() };
      this.#pairs.set(key, pair);
    }
    pair[side].add(handler);
    return () => {
      pair[side].delete(handler);
      if (pair.host.size === 0 && pair.viewer.size === 0) this.#pairs.delete(key);
    };
  }

  publish(frame: SignalingFrame): void {
    const pair = this.#pairs.get(pairKey(frame.shareId, frame.viewerId));
    if (!pair) return;
    const targets = senderSide(frame) === 'host' ? pair.viewer : pair.host;
    for (const handler of targets) handler(frame);
  }
}

function pairKey(shareId: string, viewerId: string): string {
  return `${shareId}/${viewerId}`;
}

function senderSide(frame: SignalingFrame): SignalingSide {
  if (frame.kind === 'rtc-ice') return frame.from;
  return frame.kind === 'rtc-answer' ? 'viewer' : 'host';
}
