import { describe, expect, it } from 'vitest';
import { ShareRoom, type Env } from '../src/index.js';

/**
 * Relay-whitelist tests for the `rtc-ice-servers` frame — the host→viewer
 * STUN/TURN bootstrap that makes BYO TURN work for browser viewers.
 *
 * ShareRoom is driven directly with mock sockets: the relay path only needs
 * `ctx.getWebSockets()`, `ws.deserializeAttachment()`, and `ws.send()`, so no
 * real WebSocketPair / Durable Object runtime is required.
 */

interface MockAttachment {
  readonly role: 'host' | 'viewer';
  readonly shareId: string;
  readonly viewerId?: string;
  readonly name?: string;
  readonly connectedAt?: number;
}

class MockSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(private readonly att: MockAttachment) {}
  deserializeAttachment(): MockAttachment {
    return this.att;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {}
}

const SHARE_ID = 'testShare123';
const VIEWER_ID = 'viewer-1';

/** A TURN config with credentials — must survive the relay verbatim. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:turn.example.com:3478', 'turn:turn.example.com:3478?transport=tcp'], username: 'u', credential: 'p' },
];

function makeRoom(): { host: MockSocket; viewer: MockSocket; room: ShareRoom } {
  const host = new MockSocket({ role: 'host', shareId: SHARE_ID, name: 'host' });
  const viewer = new MockSocket({
    role: 'viewer',
    shareId: SHARE_ID,
    viewerId: VIEWER_ID,
    name: 'viewer',
    connectedAt: Date.now(),
  });
  const ctx = { getWebSockets: () => [host, viewer] } as unknown as DurableObjectState;
  return { host, viewer, room: new ShareRoom(ctx, {} as unknown as Env) };
}

function asWs(socket: MockSocket): WebSocket {
  return socket as unknown as WebSocket;
}

describe('rtc-ice-servers relay (BYO TURN bootstrap)', () => {
  it('relays a host rtc-ice-servers frame to the addressed viewer, iceServers intact', async () => {
    const { host, viewer, room } = makeRoom();
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: VIEWER_ID, iceServers: ICE_SERVERS }),
    );
    expect(viewer.sent).toEqual([
      { kind: 'rtc-ice-servers', shareId: SHARE_ID, viewerId: VIEWER_ID, iceServers: ICE_SERVERS },
    ]);
    expect(host.sent).toEqual([]); // no echo back to the host
  });

  it('stamps shareId from the connection, not the payload', async () => {
    const { host, viewer, room } = makeRoom();
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', shareId: 'forged-share', viewerId: VIEWER_ID, iceServers: ICE_SERVERS }),
    );
    expect(viewer.sent).toEqual([
      { kind: 'rtc-ice-servers', shareId: SHARE_ID, viewerId: VIEWER_ID, iceServers: ICE_SERVERS },
    ]);
  });

  it('DROPS rtc-ice-servers sent by a viewer (host→viewer only — never relayed to the host)', async () => {
    const { host, viewer, room } = makeRoom();
    await room.webSocketMessage(
      asWs(viewer),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: VIEWER_ID, iceServers: ICE_SERVERS }),
    );
    expect(host.sent).toEqual([]);
    expect(viewer.sent).toEqual([]);
  });

  it('rejects an oversized iceServers array (cap is 8)', async () => {
    const { host, viewer, room } = makeRoom();
    const oversized = Array.from({ length: 9 }, (_, i) => ({ urls: `stun:s${i}.example.com:19302` }));
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: VIEWER_ID, iceServers: oversized }),
    );
    expect(viewer.sent).toEqual([]);
  });

  it('relays exactly 8 entries (at the cap)', async () => {
    const { host, viewer, room } = makeRoom();
    const atCap = Array.from({ length: 8 }, (_, i) => ({ urls: `stun:s${i}.example.com:19302` }));
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: VIEWER_ID, iceServers: atCap }),
    );
    expect(viewer.sent).toEqual([
      { kind: 'rtc-ice-servers', shareId: SHARE_ID, viewerId: VIEWER_ID, iceServers: atCap },
    ]);
  });

  it('drops a host frame whose iceServers is not an array', async () => {
    const { host, viewer, room } = makeRoom();
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: VIEWER_ID, iceServers: 'stun:nope' }),
    );
    expect(viewer.sent).toEqual([]);
  });

  it('drops a host frame addressed to an unknown viewer', async () => {
    const { host, viewer, room } = makeRoom();
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: 'rtc-ice-servers', viewerId: 'no-such-viewer', iceServers: ICE_SERVERS }),
    );
    expect(viewer.sent).toEqual([]);
  });
});
