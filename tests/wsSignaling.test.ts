import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerConnection, cleanup as rtcCleanup, type DataChannel } from 'node-datachannel';
import { WebSocketServer, WebSocket as WsClient, type WebSocket as WsSocket } from 'ws';
import { SessionFeed } from '@pooriaarab/vibe-core/feed';
import { ViewerRegistry } from '../src/registry.js';
import type { Share } from '../src/types.js';
import { newShareId } from '../src/utils.js';
import { decryptFrame, encryptFrame, WebRtcTransport } from '../src/webrtc/transport.js';
import { WsSignaling } from '../src/webrtc/wsSignaling.js';

/**
 * WsSignaling end-to-end, against a mock rendezvous that mirrors the Cloudflare
 * Worker protocol (worker/src/index.ts) 1:1 — same routes, same TOFU host-secret
 * binding, server-minted viewerIds, connection-stamped relay frames, and the
 * same rtc-offer/rtc-answer/rtc-ice/rtc-ice-servers whitelist. The real Worker
 * is verified separately with `wrangler dev`.
 */

// ------------------------------------------------------------ mock rendezvous

interface AttachedSocket {
  ws: WsSocket;
  role: 'host' | 'viewer';
  viewerId?: string;
  name: string;
}

interface ShareRoom {
  hostSecret: string | null;
  host: AttachedSocket | null;
  readonly viewers: Map<string, AttachedSocket>;
}

const MAX_FRAME_BYTES = 32 * 1024;

/** True when `value` is neither null nor undefined — what a loose `!= null` meant. */
function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

class MockRendezvous {
  readonly server: WebSocketServer;
  readonly rooms = new Map<string, ShareRoom>();

  constructor() {
    this.server = new WebSocketServer({
      port: 0,
      verifyClient: (info, cb) => {
        const url = new URL(info.req.url ?? '/', 'http://localhost');
        if (url.pathname === '/vibeshare/ws/host') {
          const share = url.searchParams.get('share') ?? '';
          const secret = url.searchParams.get('secret') ?? '';
          const room = this.rooms.get(share);
          // TOFU host-secret binding, same as the Worker's Durable Object.
          // `bound` is undefined when the room is unknown and null before the first
          // host binds, so both cases must fall through to the accept path.
          const bound = room?.hostSecret;
          if (secret.length < 16 || (isSet(bound) && bound !== secret)) {
            cb(false, 403, 'Forbidden');
            return;
          }
        }
        cb(true);
      },
    });
    this.server.on('connection', (ws, req) => this.#onConnection(ws, req));
  }

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.on('listening', () => {
        const addr = this.server.address();
        if (typeof addr !== 'object' || addr === null) {
          reject(new Error('no address'));
          return;
        }
        resolve(`ws://127.0.0.1:${addr.port}/vibeshare`);
      });
    });
  }

  close(): void {
    for (const room of this.rooms.values()) {
      room.host?.ws.close();
      for (const v of room.viewers.values()) v.ws.close();
    }
    this.server.close();
  }

  #room(shareId: string): ShareRoom {
    let room = this.rooms.get(shareId);
    if (!room) {
      room = { hostSecret: null, host: null, viewers: new Map() };
      this.rooms.set(shareId, room);
    }
    return room;
  }

  #onConnection(ws: WsSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const shareId = url.searchParams.get('share') ?? '';
    const room = this.#room(shareId);

    if (url.pathname === '/vibeshare/ws/host') {
      const secret = url.searchParams.get('secret') ?? '';
      room.hostSecret ??= secret;
      room.host?.ws.close(1012, 'host reconnected');
      const att: AttachedSocket = { ws, role: 'host', name: 'host' };
      room.host = att;
      ws.send(JSON.stringify({ kind: 'host-ready' }));
      this.#broadcastPresence(room);
      ws.on('message', (data) => this.#onHostFrame(room, shareId, att, String(data)));
      ws.on('close', () => {
        if (room.host?.ws === ws) room.host = null;
        for (const v of room.viewers.values()) v.ws.close(1012, 'host left');
      });
      return;
    }

    if (url.pathname === '/vibeshare/ws/viewer') {
      const viewerId = randomUUID(); // server-minted, unforgeable
      const att: AttachedSocket = {
        ws,
        role: 'viewer',
        viewerId,
        name: `viewer-${viewerId.replace(/-/g, '').slice(0, 6)}`,
      };
      room.viewers.set(viewerId, att);
      ws.send(JSON.stringify({ kind: 'assigned', viewerId }));
      room.host?.ws.send(JSON.stringify({ kind: 'viewer-joined', viewerId }));
      this.#broadcastPresence(room);
      ws.on('message', (data) => this.#onViewerFrame(room, shareId, att, String(data)));
      ws.on('close', () => {
        if (room.viewers.get(viewerId)?.ws === ws) room.viewers.delete(viewerId);
        this.#broadcastPresence(room);
      });
      return;
    }

    ws.close(1008, 'unknown route');
  }

  #onHostFrame(room: ShareRoom, shareId: string, att: AttachedSocket, text: string): void {
    const msg = parse(text);
    if (!msg) return;
    if (this.#handlePresenceChat(room, att, msg)) return;
    if (msg['kind'] === 'rtc-offer' && typeof msg['viewerId'] === 'string' && typeof msg['sdp'] === 'string') {
      room.viewers.get(msg['viewerId'])?.ws.send(
        JSON.stringify({ kind: 'rtc-offer', shareId, viewerId: msg['viewerId'], sdp: msg['sdp'] }),
      );
      return;
    }
    // Mirror worker: host→viewer ONLY, ≤8 entries, relayed verbatim.
    if (
      msg['kind'] === 'rtc-ice-servers' &&
      typeof msg['viewerId'] === 'string' &&
      Array.isArray(msg['iceServers']) &&
      msg['iceServers'].length <= 8
    ) {
      room.viewers.get(msg['viewerId'])?.ws.send(
        JSON.stringify({
          kind: 'rtc-ice-servers',
          shareId,
          viewerId: msg['viewerId'],
          iceServers: msg['iceServers'],
        }),
      );
      return;
    }
    if (
      msg['kind'] === 'rtc-ice' &&
      typeof msg['viewerId'] === 'string' &&
      typeof msg['candidate'] === 'string' &&
      typeof msg['mid'] === 'string'
    ) {
      room.viewers.get(msg['viewerId'])?.ws.send(
        JSON.stringify({
          kind: 'rtc-ice',
          shareId,
          viewerId: msg['viewerId'],
          candidate: msg['candidate'],
          mid: msg['mid'],
          from: 'host',
        }),
      );
    }
    // anything else: dropped (whitelist relay)
  }

  #onViewerFrame(room: ShareRoom, shareId: string, att: AttachedSocket, text: string): void {
    const msg = parse(text);
    if (!msg) return;
    if (this.#handlePresenceChat(room, att, msg)) return;
    const viewerId = att.viewerId!;
    // rtc-ice-servers is host→viewer ONLY — a viewer-sent copy is rejected
    // (mirror worker/src/index.ts relayFromViewer).
    if (msg['kind'] === 'rtc-ice-servers') return;
    // Stamped with the CONNECTION's own (shareId, viewerId) — client-supplied
    // identity fields are ignored, so a viewer cannot impersonate anyone.
    if (msg['kind'] === 'rtc-answer' && typeof msg['sdp'] === 'string') {
      room.host?.ws.send(JSON.stringify({ kind: 'rtc-answer', shareId, viewerId, sdp: msg['sdp'] }));
      return;
    }
    if (msg['kind'] === 'rtc-ice' && typeof msg['candidate'] === 'string' && typeof msg['mid'] === 'string') {
      room.host?.ws.send(
        JSON.stringify({ kind: 'rtc-ice', shareId, viewerId, candidate: msg['candidate'], mid: msg['mid'], from: 'viewer' }),
      );
    }
  }

  #handlePresenceChat(room: ShareRoom, att: AttachedSocket, msg: Record<string, unknown>): boolean {
    if (msg['kind'] === 'hello') {
      const raw = typeof msg['name'] === 'string' ? msg['name'] : '';
      // Mirror worker: strip controls / cap length (tests import the real helper).
      const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 32);
      att.name = cleaned.length > 0 ? cleaned : att.role === 'host' ? 'host' : att.name;
      this.#broadcastPresence(room);
      return true;
    }
    if (msg['kind'] === 'chat') {
      if (typeof msg['text'] !== 'string' || msg['text'].length === 0) return true;
      const viewerId = att.role === 'host' ? 'host' : att.viewerId!;
      // STAMP identity from the connection — ignore payload viewerId/name.
      this.#broadcastAll(room, {
        kind: 'chat',
        viewerId,
        name: att.name,
        role: att.role,
        text: msg['text'],
        ts: Date.now(),
      });
      return true;
    }
    // Viewer → host: request to drive. Identity from CONNECTION only.
    if (msg['kind'] === 'join-request') {
      if (att.role !== 'viewer' || !att.viewerId || !room.host) return true;
      room.host.ws.send(
        JSON.stringify({
          kind: 'join-request',
          viewerId: att.viewerId,
          name: att.name,
        }),
      );
      return true;
    }
    // Host → one viewer: role decision after approve/deny.
    if (msg['kind'] === 'role-update') {
      if (att.role !== 'host') return true;
      const viewerId = typeof msg['viewerId'] === 'string' ? msg['viewerId'] : '';
      const role =
        msg['role'] === 'collaborator'
          ? 'collaborator'
          : msg['role'] === 'spectator'
            ? 'spectator'
            : null;
      const joinRequest =
        msg['joinRequest'] === 'approved' ||
        msg['joinRequest'] === 'denied' ||
        msg['joinRequest'] === 'pending' ||
        msg['joinRequest'] === 'none'
          ? msg['joinRequest']
          : null;
      if (!viewerId || !role || !joinRequest) return true;
      const viewer = room.viewers.get(viewerId);
      if (viewer) {
        viewer.ws.send(
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

  #broadcastPresence(room: ShareRoom): void {
    const viewers: Array<{ viewerId: string; name: string; role: 'host' | 'viewer' }> = [];
    if (room.host) viewers.push({ viewerId: 'host', name: room.host.name, role: 'host' });
    for (const [id, v] of room.viewers) {
      viewers.push({ viewerId: id, name: v.name, role: 'viewer' });
    }
    this.#broadcastAll(room, { kind: 'presence', viewers });
  }

  #broadcastAll(room: ShareRoom, frame: unknown): void {
    const text = JSON.stringify(frame);
    room.host?.ws.send(text);
    for (const v of room.viewers.values()) v.ws.send(text);
  }
}

function parse(text: string): Record<string, unknown> | null {
  if (text.length > MAX_FRAME_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ test scaffolding

function makeShare(access: Share['access'] = 'spectate'): Share {
  return {
    id: newShareId(),
    name: 'ws-signaling-test',
    access,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    state: 'live',
    passphraseHash: null,
  };
}

function keyFromUrl(url: string): Buffer {
  return Buffer.from(new URL(url).hash.slice(1), 'base64url');
}

/**
 * A raw ws client whose message sink is attached at construction — messages
 * arriving before the caller's first `waitForMsg` are still recorded.
 */
interface RawClient {
  readonly ws: WsSocket;
  readonly msgs: Array<Record<string, unknown>>;
  readonly opened: Promise<void>;
  readonly failed: Promise<Error>;
}

function rawClient(url: string): RawClient {
  const ws = new WsClient(url);
  const msgs: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    const msg = parse(String(data));
    if (msg) msgs.push(msg);
  });
  const opened = new Promise<void>((resolve) => ws.on('open', resolve));
  const failed = new Promise<Error>((resolve) => ws.on('error', resolve));
  return { ws, msgs, opened, failed };
}

/** Wait for the next message of `kind` recorded since `start` (default: now). */
async function waitForMsg(client: RawClient, kind: string, start = 0, timeoutMs = 4000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = client.msgs.slice(start).find((m) => m['kind'] === kind);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${kind}"; got ${JSON.stringify(client.msgs)}`);
    }
    await sleep(10);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WsSignaling over a mock rendezvous', () => {
  let rendezvous: MockRendezvous;
  let base: string;
  let transports: WebRtcTransport[];
  let signalings: WsSignaling[];
  let viewerPcs: PeerConnection[];
  let raws: WsSocket[];

  beforeEach(async () => {
    rendezvous = new MockRendezvous();
    base = await rendezvous.listen();
    transports = [];
    signalings = [];
    viewerPcs = [];
    raws = [];
  });

  afterEach(async () => {
    for (const ws of raws.splice(0)) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    for (const pc of viewerPcs.splice(0)) {
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    for (const t of transports.splice(0)) await t.close();
    for (const s of signalings.splice(0)) s.close();
    rendezvous.close();
  });

  afterAll(() => {
    rtcCleanup();
  });

  const makeSignaling = (errors?: Error[]): WsSignaling => {
    const s = new WsSignaling({ url: base, ...(errors ? { onError: (e) => errors.push(e) } : {}) });
    signalings.push(s);
    return s;
  };

  /** A viewer peer driven through WsSignaling, mirroring the browser page. */
  function connectViewer(
    viewerSignaling: WsSignaling,
    shareId: string,
    onChannel: (dc: DataChannel) => void,
  ): { pc: PeerConnection; opened: Promise<DataChannel> } {
    const pc = new PeerConnection(`viewer-${shareId}`, { iceServers: [] });
    viewerPcs.push(pc);
    let remoteDescSet = false;
    const queued: Array<{ candidate: string; mid: string }> = [];

    pc.onLocalDescription((sdp) => viewerSignaling.publish({ kind: 'rtc-answer', shareId, viewerId: 'v', sdp }));
    pc.onLocalCandidate((candidate, mid) => {
      if (candidate !== '') viewerSignaling.publish({ kind: 'rtc-ice', shareId, viewerId: 'v', candidate, mid, from: 'viewer' });
    });

    let resolveOpen!: (dc: DataChannel) => void;
    const opened = new Promise<DataChannel>((resolve) => {
      resolveOpen = resolve;
    });
    // One onDataChannel registration, handlers attached synchronously (it is
    // a setter — a second call would replace it and drop the open callback).
    pc.onDataChannel((dc) => {
      onChannel(dc);
      dc.onOpen(() => resolveOpen(dc));
    });

    viewerSignaling.subscribe(shareId, 'v', 'viewer', (frame) => {
      try {
        if (frame.kind === 'rtc-offer') {
          pc.setRemoteDescription(frame.sdp, 'offer');
          remoteDescSet = true;
          for (const c of queued) pc.addRemoteCandidate(c.candidate, c.mid);
          queued.length = 0;
        } else if (frame.kind === 'rtc-ice') {
          if (remoteDescSet) pc.addRemoteCandidate(frame.candidate, frame.mid);
          else queued.push(frame);
        }
      } catch {
        // closing mid-handshake
      }
    });
    viewerSignaling.announceViewer(shareId, 'v');
    return { pc, opened };
  }

  it('drives the same 2-peer handshake + encrypted feed as LoopbackSignaling (drop-in)', async () => {
    const hostSignaling = makeSignaling();
    const transport = new WebRtcTransport({ signaling: hostSignaling });
    transports.push(transport);

    const share = makeShare();
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await transport.serve(share, feed, viewers);
    const key = keyFromUrl(url);

    feed.publish('before connect', { stream: 'stdout' });
    feed.publishRaw(Buffer.from('raw-bytes', 'utf8'));
    feed.publishResize(90, 28);

    const received = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const entries: Array<Record<string, unknown>> = [];
      const timer = setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(entries)}`)), 8000);
      const viewer = connectViewer(makeSignaling(), share.id, (dc) => {
        dc.onMessage((msg) => {
          const frame = typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg instanceof ArrayBuffer ? Buffer.from(msg) : msg;
          try {
            entries.push(JSON.parse(decryptFrame(key, frame).toString('utf8')) as Record<string, unknown>);
          } catch (err) {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          if (entries.length >= 5) {
            clearTimeout(timer);
            resolve(entries);
          }
        });
      });
      viewer.opened.then(() => feed.publish('live one')).then(() => feed.publish('live two'));
    });

    const entries = await received;
    expect(entries.map((e) => e['seq'])).toEqual([1, 2, 3, 4, 5]);
    expect(entries[0]).toMatchObject({ type: 'output', text: 'before connect' });
    expect(entries[1]).toMatchObject({ type: 'raw' });
    expect(Buffer.from(String(entries[1]!['data']), 'base64').toString('utf8')).toBe('raw-bytes');
    expect(entries[2]).toMatchObject({ type: 'resize', cols: 90, rows: 28 });
    expect(entries.map((e) => e['text']).filter(Boolean)).toEqual(['before connect', 'live one', 'live two']);
    feed.close();
  });

  it('drops input from a rendezvous viewer the host registry never approved', async () => {
    // Over the rendezvous the Worker mints viewerIds; the host's ViewerRegistry
    // only knows ids from its own approve flow. Until a public join handshake
    // exists (post–slice 2), canWrite() is false for every rendezvous id —
    // so ALL input arriving on the DataChannel is dropped, seq or not.
    const inputs: Array<{ shareId: string; viewerId: string; data: string }> = [];
    const transport = new WebRtcTransport({
      signaling: makeSignaling(),
      onInput: (shareId, viewerId, data) => inputs.push({ shareId, viewerId, data }),
    });
    transports.push(transport);

    const share = makeShare('invite');
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await transport.serve(share, feed, viewers);
    const key = keyFromUrl(url);

    const gotEntry = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no feed entry received')), 8000);
      const viewer = connectViewer(makeSignaling(), share.id, (dc) => {
        dc.onMessage((msg) => {
          const frame = typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg instanceof ArrayBuffer ? Buffer.from(msg) : msg;
          try {
            decryptFrame(key, frame);
          } catch (err) {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          clearTimeout(timer);
          resolve();
        });
      });
      void viewer.opened.then((dc) => {
        // The data plane works — only the INPUT gate rejects this viewer.
        dc.sendMessageBinary(encryptFrame(key, Buffer.from(JSON.stringify({ kind: 'input', data: 'rm -rf /', seq: 1 }), 'utf8')));
        feed.publish('proof the channel is live');
      });
    });

    await gotEntry;
    await sleep(300);
    expect(inputs).toEqual([]); // dropped at canWrite — never applied
    feed.close();
  });

  // -------------------------------------------------- rendezvous security

  it('the server mints viewerIds and stamps relayed frames — a viewer cannot claim another identity', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'a'.repeat(32)}`);
    raws.push(host.ws);
    await host.opened;
    await waitForMsg(host, 'host-ready');

    const v1 = rawClient(`${base}/ws/viewer?share=${shareId}`);
    const v2 = rawClient(`${base}/ws/viewer?share=${shareId}`);
    raws.push(v1.ws, v2.ws);
    const assigned1 = await waitForMsg(v1, 'assigned');
    const assigned2 = await waitForMsg(v2, 'assigned');
    const id1 = assigned1['viewerId'] as string;
    const id2 = assigned2['viewerId'] as string;
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
    expect(id1).not.toBe(id2); // fresh per connection, never client-chosen

    // Host is told about both viewers by their server-minted ids.
    const joined1 = await waitForMsg(host, 'viewer-joined');
    const joined2 = await waitForMsg(host, 'viewer-joined', host.msgs.indexOf(joined1) + 1);
    expect([joined1['viewerId'], joined2['viewerId']].sort()).toEqual([id1, id2].sort());

    // v1 tries to answer AS v2 (claims shareId + viewerId in its frame).
    const before = host.msgs.length;
    v1.ws.send(JSON.stringify({ kind: 'rtc-answer', shareId, viewerId: id2, sdp: 'forged' }));
    const answer = await waitForMsg(host, 'rtc-answer', before);
    expect(answer['viewerId']).toBe(id1); // stamped with the connection's own id
    expect(answer['shareId']).toBe(shareId);
    expect(answer['sdp']).toBe('forged'); // payload relayed, identity overridden

    // Cross-pair isolation: v1's frames never reach v2.
    expect(v2.msgs.filter((m) => m['kind'] === 'rtc-answer')).toEqual([]);
  });

  it('authenticates the host by its minted secret: a second host with a wrong secret is rejected', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'a'.repeat(32)}`);
    raws.push(host.ws);
    await waitForMsg(host, 'host-ready');

    const intruder = rawClient(`${base}/ws/host?share=${shareId}&secret=${'b'.repeat(32)}`);
    raws.push(intruder.ws);
    const err = await intruder.failed;
    expect(err.message).toContain('403');

    // …and the legitimate host keeps working (the right secret re-binds).
    const hostAgain = rawClient(`${base}/ws/host?share=${shareId}&secret=${'a'.repeat(32)}`);
    raws.push(hostAgain.ws);
    await waitForMsg(hostAgain, 'host-ready');
  });

  it('relays ONLY rtc-offer/rtc-answer/rtc-ice + presence/chat — anything else is dropped', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'c'.repeat(32)}`);
    raws.push(host.ws);
    await waitForMsg(host, 'host-ready');

    const viewer = rawClient(`${base}/ws/viewer?share=${shareId}`);
    raws.push(viewer.ws);
    const assigned = await waitForMsg(viewer, 'assigned');
    const viewerId = assigned['viewerId'] as string;
    await waitForMsg(host, 'viewer-joined');

    // A viewer trying to smuggle session bytes / a key / a bogus frame shape.
    viewer.ws.send(JSON.stringify({ kind: 'rtc-data', shareId, viewerId, payload: 'session bytes' }));
    viewer.ws.send(JSON.stringify({ kind: 'key', shareId, viewerId, key: 'AES KEY MATERIAL' }));
    viewer.ws.send(JSON.stringify({ kind: 'rtc-offer', sdp: 'viewer may not offer' }));
    // A viewer may NOT push ICE servers (that frame is host→viewer only).
    viewer.ws.send(
      JSON.stringify({ kind: 'rtc-ice-servers', iceServers: [{ urls: 'turn:evil.example.com:3478', username: 'x', credential: 'y' }] }),
    );
    viewer.ws.send('not even json');
    // …and the host trying to answer (wrong direction) or inject a key.
    host.ws.send(JSON.stringify({ kind: 'rtc-answer', viewerId, sdp: 'host may not answer' }));
    host.ws.send(JSON.stringify({ kind: 'key', viewerId, key: 'AES KEY MATERIAL' }));

    await sleep(300);
    const allowed = new Set([
      'host-ready',
      'viewer-joined',
      'assigned',
      'presence',
      'chat',
      'join-request',
      'role-update',
    ]);
    const hostExtra = host.msgs.filter((m) => !allowed.has(String(m['kind'])));
    const viewerExtra = viewer.msgs.filter((m) => !allowed.has(String(m['kind'])));
    expect(hostExtra).toEqual([]);
    expect(viewerExtra).toEqual([]);
  });

  it('relays host rtc-ice-servers to the addressed viewer with iceServers intact', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'d'.repeat(32)}`);
    raws.push(host.ws);
    await waitForMsg(host, 'host-ready');

    const viewer = rawClient(`${base}/ws/viewer?share=${shareId}`);
    raws.push(viewer.ws);
    const assigned = await waitForMsg(viewer, 'assigned');
    const viewerId = assigned['viewerId'] as string;
    await waitForMsg(host, 'viewer-joined');

    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    host.ws.send(JSON.stringify({ kind: 'rtc-ice-servers', viewerId, iceServers }));

    const frame = await waitForMsg(viewer, 'rtc-ice-servers');
    expect(frame['shareId']).toBe(shareId); // connection-stamped, not payload
    expect(frame['viewerId']).toBe(viewerId);
    expect(frame['iceServers']).toEqual(iceServers); // verbatim, creds included
  });

  it('WebRtcTransport publishes rtc-ice-servers BEFORE the offer (TURN config lands first)', async () => {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    const hostSignaling = makeSignaling();
    const transport = new WebRtcTransport({ signaling: hostSignaling, iceServers });
    transports.push(transport);

    const share = makeShare();
    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    await transport.serve(share, feed, viewers);

    const viewerSignaling = makeSignaling();
    const kinds: string[] = [];
    const offerSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${kinds.join(',')}`)), 8000);
      viewerSignaling.subscribe(share.id, 'v', 'viewer', (frame) => {
        kinds.push(frame.kind);
        if (frame.kind === 'rtc-ice-servers') {
          expect(frame.iceServers).toEqual(iceServers);
        }
        if (frame.kind === 'rtc-offer') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    viewerSignaling.announceViewer(share.id, 'v');
    await offerSeen;
    expect(kinds[0]).toBe('rtc-ice-servers');
    expect(kinds).toContain('rtc-offer');
  });

  it('stamps join-request from the connection and relays host role-update to that viewer', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'j'.repeat(32)}`);
    raws.push(host.ws);
    await waitForMsg(host, 'host-ready');

    const viewer = rawClient(`${base}/ws/viewer?share=${shareId}`);
    raws.push(viewer.ws);
    const assigned = await waitForMsg(viewer, 'assigned');
    const viewerId = assigned['viewerId'] as string;
    await waitForMsg(host, 'viewer-joined');

    // Viewer hellos so the hub has a display name, then requests to drive.
    // Any client-supplied viewerId on the payload is discarded.
    viewer.ws.send(JSON.stringify({ kind: 'hello', name: 'Ada' }));
    await waitForMsg(host, 'presence');
    viewer.ws.send(JSON.stringify({ kind: 'join-request', viewerId: 'forged-id', name: 'Eve' }));

    const jr = await waitForMsg(host, 'join-request');
    expect(jr['viewerId']).toBe(viewerId); // connection-stamped, not forged
    expect(jr['name']).toBe('Ada');

    // Host approves → role-update reaches ONLY that viewer.
    host.ws.send(
      JSON.stringify({
        kind: 'role-update',
        viewerId,
        role: 'collaborator',
        joinRequest: 'approved',
      }),
    );
    const ru = await waitForMsg(viewer, 'role-update');
    expect(ru).toMatchObject({
      kind: 'role-update',
      viewerId,
      role: 'collaborator',
      joinRequest: 'approved',
    });

    // A viewer cannot mint a role-update for themselves.
    const before = viewer.msgs.length;
    viewer.ws.send(
      JSON.stringify({
        kind: 'role-update',
        viewerId,
        role: 'collaborator',
        joinRequest: 'approved',
      }),
    );
    await sleep(200);
    const sneaky = viewer.msgs.slice(before).filter((m) => m['kind'] === 'role-update');
    expect(sneaky).toEqual([]);
  });

  it('broadcasts a presence roster on join/hello/leave and stamps chat from the connection', async () => {
    const shareId = newShareId();
    const host = rawClient(`${base}/ws/host?share=${shareId}&secret=${'f'.repeat(32)}`);
    raws.push(host.ws);
    await waitForMsg(host, 'host-ready');

    const v1 = rawClient(`${base}/ws/viewer?share=${shareId}`);
    raws.push(v1.ws);
    const assigned1 = await waitForMsg(v1, 'assigned');
    const id1 = assigned1['viewerId'] as string;
    await waitForMsg(host, 'viewer-joined');

    // Presence includes host + viewer after join.
    const presence1 = await waitForMsg(v1, 'presence');
    const roster1 = presence1['viewers'] as Array<Record<string, unknown>>;
    expect(roster1.some((r) => r['role'] === 'host')).toBe(true);
    expect(roster1.some((r) => r['viewerId'] === id1)).toBe(true);

    // Viewer renames via hello → roster updates for everyone.
    const beforeHello = host.msgs.length;
    v1.ws.send(JSON.stringify({ kind: 'hello', name: 'Ada' }));
    const presence2 = await waitForMsg(host, 'presence', beforeHello);
    const ada = (presence2['viewers'] as Array<Record<string, unknown>>).find((r) => r['viewerId'] === id1);
    expect(ada?.['name']).toBe('Ada');

    // Chat: client claims a forged identity; hub stamps the real connection.
    const beforeChat = host.msgs.length;
    v1.ws.send(
      JSON.stringify({
        kind: 'chat',
        viewerId: 'forged-id',
        name: 'Eve',
        text: 'cGxhaW50ZXh0LWFzLWNpcGhlcnRleHQ=', // opaque base64 blob
      }),
    );
    const chat = await waitForMsg(host, 'chat', beforeChat);
    expect(chat['viewerId']).toBe(id1); // connection-stamped
    expect(chat['name']).toBe('Ada'); // live attachment name, not payload
    expect(chat['role']).toBe('viewer');
    expect(chat['text']).toBe('cGxhaW50ZXh0LWFzLWNpcGhlcnRleHQ=');
    // Fan-out: the sender also sees the stamped relay.
    const chatToV1 = await waitForMsg(v1, 'chat');
    expect(chatToV1['viewerId']).toBe(id1);
    expect(chatToV1['name']).toBe('Ada');
  });

  it('keeps shares isolated: a viewer-joined on one share is not fanned out to another', async () => {
    const shareA = newShareId();
    const shareB = newShareId();
    const hostA = rawClient(`${base}/ws/host?share=${shareA}&secret=${'d'.repeat(32)}`);
    const hostB = rawClient(`${base}/ws/host?share=${shareB}&secret=${'e'.repeat(32)}`);
    raws.push(hostA.ws, hostB.ws);
    await waitForMsg(hostA, 'host-ready');
    await waitForMsg(hostB, 'host-ready');

    const viewer = rawClient(`${base}/ws/viewer?share=${shareA}`);
    raws.push(viewer.ws);
    await waitForMsg(viewer, 'assigned');

    const joined = await waitForMsg(hostA, 'viewer-joined');
    expect(typeof joined['viewerId']).toBe('string');
    await sleep(200);
    expect(hostB.msgs.filter((m) => m['kind'] === 'viewer-joined')).toEqual([]);
  });
});
