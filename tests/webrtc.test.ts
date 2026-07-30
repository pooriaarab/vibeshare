import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerConnection, cleanup as rtcCleanup, type DataChannel } from 'node-datachannel';
import { SessionFeed } from '../src/feed.js';
import { ViewerRegistry } from '../src/registry.js';
import type { Share } from '../src/types.js';
import { newShareId } from '../src/utils.js';
import { LoopbackSignaling } from '../src/webrtc/signaling.js';
import { WebRtcTransport, decryptFrame, encryptFrame } from '../src/webrtc/transport.js';

/**
 * REAL end-to-end: the host transport and a raw node-datachannel viewer
 * peer connect over loopback ICE through LoopbackSignaling. The viewer
 * decrypts with the key carried in the share URL fragment — exactly what a
 * browser client would do. No STUN, no network, no external signaling.
 */

interface ViewerPeer {
  readonly pc: PeerConnection;
  /** Resolves with the DataChannel once it is open on the viewer side. */
  readonly opened: Promise<DataChannel>;
}

function makeShare(access: Share['access'] = 'spectate'): Share {
  return {
    id: newShareId(),
    name: 'webrtc-test',
    access,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    state: 'live',
    passphraseHash: null,
  };
}

/** The 256-bit key from `https://…/s/<id>#<keyB64url>` — the fragment only. */
function keyFromUrl(url: string): Buffer {
  return Buffer.from(new URL(url).hash.slice(1), 'base64url');
}

/** Drive the viewer half of the handshake by hand (the future browser client). */
function connectViewer(
  signaling: LoopbackSignaling,
  shareId: string,
  viewerId: string,
  onChannel?: (dc: DataChannel) => void,
): ViewerPeer {
  const pc = new PeerConnection(`viewer-${viewerId}`, { iceServers: [] });
  let remoteDescSet = false;
  const queuedCandidates: Array<{ candidate: string; mid: string }> = [];

  pc.onLocalDescription((sdp) => {
    signaling.publish({ kind: 'rtc-answer', shareId, viewerId, sdp });
  });
  pc.onLocalCandidate((candidate, mid) => {
    if (candidate === '') return;
    signaling.publish({ kind: 'rtc-ice', shareId, viewerId, candidate, mid, from: 'viewer' });
  });

  let resolveOpen!: (dc: DataChannel) => void;
  const opened = new Promise<DataChannel>((resolve) => {
    resolveOpen = resolve;
  });
  pc.onDataChannel((dc) => {
    // Attach message handlers synchronously so no early frame is missed.
    onChannel?.(dc);
    dc.onOpen(() => resolveOpen(dc));
  });

  signaling.subscribe(shareId, viewerId, 'viewer', (frame) => {
    try {
      if (frame.kind === 'rtc-offer') {
        pc.setRemoteDescription(frame.sdp, 'offer');
        remoteDescSet = true;
        for (const c of queuedCandidates) pc.addRemoteCandidate(c.candidate, c.mid);
        queuedCandidates.length = 0;
      } else if (frame.kind === 'rtc-ice') {
        if (remoteDescSet) pc.addRemoteCandidate(frame.candidate, frame.mid);
        else queuedCandidates.push(frame);
      }
    } catch {
      // closing mid-handshake
    }
  });

  signaling.announceViewer(shareId, viewerId);
  return { pc, opened };
}

/** Collect `count` decrypted feed entries from a viewer DataChannel. */
function collectEntries(
  dc: DataChannel,
  key: Buffer,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const entries: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => reject(new Error(`timed out with ${JSON.stringify(entries)}`)), 8000);
    dc.onMessage((msg) => {
      const frame =
        typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg instanceof ArrayBuffer ? Buffer.from(msg) : msg;
      try {
        entries.push(JSON.parse(decryptFrame(key, frame).toString('utf8')) as Record<string, unknown>);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (entries.length >= count) {
        clearTimeout(timer);
        resolve(entries);
      }
    });
  });
}

function sendInput(dc: DataChannel, key: Buffer, data: string): void {
  dc.sendMessageBinary(encryptFrame(key, Buffer.from(JSON.stringify({ kind: 'input', data }), 'utf8')));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WebRtcTransport (real node-datachannel peers over loopback)', () => {
  let signaling: LoopbackSignaling;
  let transport: WebRtcTransport;
  let viewerPcs: PeerConnection[];
  let inputs: Array<{ shareId: string; viewerId: string; data: string }>;

  beforeEach(() => {
    signaling = new LoopbackSignaling();
    viewerPcs = [];
    inputs = [];
  });

  afterEach(async () => {
    for (const pc of viewerPcs.splice(0)) {
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    await transport.close();
  });

  afterAll(() => {
    rtcCleanup();
  });

  /** Track a viewer peer so afterEach always tears it down. */
  const connect = (...args: Parameters<typeof connectViewer>): ViewerPeer => {
    const peer = connectViewer(...args);
    viewerPcs.push(peer.pc);
    return peer;
  };

  it('streams the exact feed bytes to a viewer, decryptable only with the URL key', async () => {
    transport = new WebRtcTransport({ signaling });

    const share = makeShare();
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await transport.serve(share, feed, viewers);

    expect(transport.kind).toBe('webrtc');
    expect(url.startsWith(`https://getvibe.dev/vibeshare/s/${share.id}#`)).toBe(true);
    const key = keyFromUrl(url);
    expect(key.length).toBe(32);

    feed.publish('before connect', { stream: 'stdout' });

    let received!: Promise<Array<Record<string, unknown>>>;
    const viewer = connect(signaling, share.id, 'viewer-1', (dc) => {
      received = collectEntries(dc, key, 3);
    });
    await viewer.opened;
    feed.publish('live one');
    feed.publish('live two');

    const entries = await received;
    expect(entries.map((e) => e['text'])).toEqual(['before connect', 'live one', 'live two']);
    expect(entries.map((e) => e['seq'])).toEqual([1, 2, 3]);
    expect(entries[0]).toMatchObject({ stream: 'stdout', type: 'output' });
    feed.close();
  });

  it('drops spectator input silently and applies approved-collaborator input', async () => {
    transport = new WebRtcTransport({
      signaling,
      onInput: (shareId, viewerId, data) => inputs.push({ shareId, viewerId, data }),
    });

    const share = makeShare('invite');
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await transport.serve(share, feed, viewers);
    const key = keyFromUrl(url);

    const spectator = viewers.add('Spec');
    const participant = viewers.add('Part');
    viewers.requestJoin(participant.id);
    viewers.approve(participant.id);
    expect(viewers.canWrite(spectator.id)).toBe(false);
    expect(viewers.canWrite(participant.id)).toBe(true);

    const specDc = await connect(signaling, share.id, spectator.id).opened;
    sendInput(specDc, key, 'spectator was here');
    await sleep(250);
    expect(inputs).toEqual([]); // gated out by canWrite, silently

    const partDc = await connect(signaling, share.id, participant.id).opened;
    sendInput(partDc, key, 'ls -la');
    await vi.waitFor(() => {
      expect(inputs).toEqual([{ shareId: share.id, viewerId: participant.id, data: 'ls -la' }]);
    });
    feed.close();
  });

  it('AES-GCM: tampered ciphertext fails authentication and never yields plaintext', async () => {
    // Unit level: flip a bit, wrong key, truncation — all must throw.
    const unitKey = randomBytes(32);
    const frame = encryptFrame(unitKey, Buffer.from('top secret', 'utf8'));
    expect(decryptFrame(unitKey, frame).toString('utf8')).toBe('top secret');

    const tampered = Buffer.from(frame);
    tampered[20] = tampered[20]! ^ 0x01;
    expect(() => decryptFrame(unitKey, tampered)).toThrow();
    expect(() => decryptFrame(randomBytes(32), frame)).toThrow();
    expect(() => decryptFrame(unitKey, frame.subarray(0, 10))).toThrow();

    // Wire level: a tampered input frame is dropped, the peer stays usable.
    transport = new WebRtcTransport({
      signaling,
      onInput: (shareId, viewerId, data) => inputs.push({ shareId, viewerId, data }),
    });

    const share = makeShare('invite');
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await transport.serve(share, feed, viewers);
    const key = keyFromUrl(url);

    const participant = viewers.add('Part');
    viewers.requestJoin(participant.id);
    viewers.approve(participant.id);

    const dc = await connect(signaling, share.id, participant.id).opened;
    const good = encryptFrame(key, Buffer.from(JSON.stringify({ kind: 'input', data: 'real input' }), 'utf8'));
    const bad = Buffer.from(good);
    bad[14] = bad[14]! ^ 0xff;

    dc.sendMessageBinary(bad);
    await sleep(250);
    expect(inputs).toEqual([]); // auth failure — dropped, never applied

    dc.sendMessageBinary(good);
    await vi.waitFor(() => {
      expect(inputs).toEqual([{ shareId: share.id, viewerId: participant.id, data: 'real input' }]);
    });
    feed.close();
  });

  it('unserve disconnects the viewer; close is idempotent', async () => {
    transport = new WebRtcTransport({ signaling });

    const share = makeShare();
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    await transport.serve(share, feed, viewers);

    const viewer = connect(signaling, share.id, 'viewer-x');
    const dc = await viewer.opened;
    expect(transport.peerCount(share.id)).toBe(1);

    const gone = new Promise<void>((resolve) => {
      dc.onClosed(() => resolve());
      viewer.pc.onStateChange((state) => {
        if (state === 'closed' || state === 'disconnected' || state === 'failed') resolve();
      });
    });
    await transport.unserve(share.id);
    await gone; // the viewer side observes the teardown
    expect(transport.peerCount(share.id)).toBe(0);

    await transport.unserve(share.id); // idempotent
    await transport.close();
    await transport.close(); // idempotent
    expect(transport.shareCount).toBe(0);
    feed.close();
  });
});
