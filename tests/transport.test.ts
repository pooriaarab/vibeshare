import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import { LocalHttpTransport } from '../src/localHttp.js';
import { ShareManager, SHARE_SCOPE, type CreatedShare } from '../src/manager.js';
import { readSse, readSseUntilClose } from './helpers.js';

describe('LocalHttpTransport (end-to-end over real HTTP)', () => {
  let transport: LocalHttpTransport;
  let manager: ShareManager;
  let base: string;
  const HOST_TOKEN = 'test-host-token';
  const inputs: Array<{ shareId: string; viewerId: string; data: string }> = [];
  const joinReqs: Array<{ shareId: string; id: string; name: string }> = [];

  beforeEach(async () => {
    inputs.length = 0;
    joinReqs.length = 0;
    const consent = createConsentLedger();
    consent.grant(SHARE_SCOPE, 'test');
    transport = new LocalHttpTransport({
      hostToken: HOST_TOKEN,
      onInput: (shareId, viewerId, data) => inputs.push({ shareId, viewerId, data }),
      onJoinRequest: (shareId, v) => joinReqs.push({ shareId, id: v.id, name: v.name }),
    });
    await transport.listen();
    manager = new ShareManager({ consent, transport });
    base = `http://127.0.0.1:${transport.port}`;
  });

  afterEach(async () => {
    await manager.stopAll();
    await transport.close();
  });

  const control = (path: string, init?: RequestInit, token: string | null = HOST_TOKEN) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    });

  const join = async (created: CreatedShare, body: Record<string, unknown> = {}) => {
    const res = await fetch(`${created.url}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('serves the spectator page and meta', async () => {
    const created = await manager.createShare({ name: 'demo', passphrase: 'pw' });
    const page = await fetch(created.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('vibeshare');
    expect(html).toContain(created.share.id);
    // Inlined xterm.js (CSP-safe) — no external script CDN.
    expect(html).toContain('new Terminal');
    expect(html).toContain('__vsHandleEntry');
    expect(html).not.toMatch(/src=["']https?:\/\//);

    const meta = await (await fetch(`${created.url}/meta`)).json() as Record<string, unknown>;
    expect(meta).toMatchObject({
      id: created.share.id,
      name: 'demo',
      access: 'spectate',
      state: 'live',
      requiresPassphrase: true,
      watching: 0,
    });
  });

  it('enforces the passphrase at join', async () => {
    const created = await manager.createShare({ passphrase: 'pw' });
    expect((await join(created)).status).toBe(403);
    expect((await join(created, { pass: 'wrong' })).status).toBe(403);
    const ok = await join(created, { pass: 'pw', name: 'Maya' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ role: 'spectator' });
    expect(ok.body['token']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects unknown share ids and ended shares with 404/410', async () => {
    const created = await manager.createShare();
    expect((await fetch(`${base}/s/nope/meta`)).status).toBe(404);
    await created.revoke();
    expect((await fetch(`${created.url}/meta`)).status).toBe(410);
    expect((await join(created)).status).toBe(410);
  });

  it('streams published entries live and replays the backlog for late joiners', async () => {
    const created = await manager.createShare();
    created.feed.publish('early line');
    created.feed.publishRaw(Buffer.from('\x1b[32mhi\x1b[0m', 'utf8'));
    created.feed.publishResize(80, 24);

    const v1 = await join(created, { name: 'first' });
    const stream1 = await fetch(`${created.url}/stream?token=${v1.body['token']}`);
    expect(stream1.status).toBe(200);

    // First viewer gets the replayed backlog (share-opened line, then ours).
    const replay = await readSse(stream1, (ev) => ev.filter((e) => e.event === 'entry').length >= 4);
    expect(replay[0]).toMatchObject({ event: 'entry' });
    const replayEntries = replay.filter((e) => e.event === 'entry').map((e) => JSON.parse(e.data) as Record<string, unknown>);
    expect(replayEntries.some((e) => e['text'] === 'early line')).toBe(true);
    const raw = replayEntries.find((e) => e['type'] === 'raw');
    expect(raw).toBeDefined();
    expect(Buffer.from(String(raw!['data']), 'base64').toString('utf8')).toBe('\x1b[32mhi\x1b[0m');
    expect(replayEntries.some((e) => e['type'] === 'resize' && e['cols'] === 80 && e['rows'] === 24)).toBe(true);

    created.feed.publish('live one', { stream: 'stdout' });
    created.feed.system('checkpoint');

    // A second viewer joining now replays everything so far, in order.
    const v2 = await join(created, { name: 'second' });
    const stream2 = await fetch(`${created.url}/stream?token=${v2.body['token']}`);
    const backlog = await readSse(stream2, (ev) => ev.filter((e) => e.event === 'entry').length >= 5);
    const entries = backlog.filter((e) => e.event === 'entry').map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const texts = entries.filter((e) => typeof e['text'] === 'string').map((e) => e['text']);
    expect(texts.slice(0, 4)).toEqual([
      'share opened · access=spectate · until stopped',
      'early line',
      'live one',
      'checkpoint',
    ]);
    expect(entries.some((e) => e['type'] === 'raw')).toBe(true);
    expect(entries.some((e) => e['type'] === 'resize')).toBe(true);

    // And both see a new live entry.
    const v3 = await join(created, { name: 'third' });
    const stream3 = await fetch(`${created.url}/stream?token=${v3.body['token']}`);
    created.feed.publish('after connect');
    const live = await readSse(stream3, (ev) =>
      ev.some((e) => e.event === 'entry' && JSON.parse(e.data).text === 'after connect'),
    );
    expect(live.at(-1)).toBeDefined();
  });

  it('requires a viewer token for the stream', async () => {
    const created = await manager.createShare();
    expect((await fetch(`${created.url}/stream?token=bogus`)).status).toBe(401);
  });

  it('request-to-join is refused on spectate shares', async () => {
    const created = await manager.createShare({ access: 'spectate' });
    const v = await join(created);
    const res = await fetch(`${created.url}/request-join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: v.body['token'] }),
    });
    expect(res.status).toBe(403);
  });

  it('full invite flow: request → host approves via control → viewer notified live', async () => {
    const created = await manager.createShare({ access: 'invite' });
    const v = await join(created, { name: 'Nick' });
    const viewerId = v.body['viewerId'] as string;
    const stream = await fetch(`${created.url}/stream?token=${v.body['token']}`);
    const reading = readSse(stream, (ev) => ev.some((e) => e.event === 'join-approved'));

    const req = await fetch(`${created.url}/request-join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: v.body['token'] }),
    });
    expect(req.status).toBe(202);
    expect(joinReqs).toEqual([{ shareId: created.share.id, id: viewerId, name: 'Nick' }]);

    // Host sees the pending request through the control API…
    const viewers = await (await control(`/control/viewers?share=${created.share.id}`)).json() as {
      viewers: Array<{ id: string; joinRequest: string }>;
    };
    expect(viewers.viewers.find((x) => x.id === viewerId)?.joinRequest).toBe('pending');

    // …approves…
    const approve = await control('/control/approve', {
      method: 'POST',
      body: JSON.stringify({ share: created.share.id, viewer: viewerId }),
    });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as { viewer: { role: string } };
    expect(approved.viewer.role).toBe('collaborator');

    // …and the viewer's stream tells them immediately.
    const events = await reading;
    expect(events.some((e) => e.event === 'join-approved')).toBe(true);
    expect(created.viewers.canWrite(viewerId)).toBe(true);
  });

  it('approved input reaches onInput; spectate/unapproved are rejected', async () => {
    // Spectate share: no input route ever opens.
    const spectate = await manager.createShare({ access: 'spectate' });
    const sv = await join(spectate, { name: 'Spec' });
    const sRes = await fetch(`${spectate.url}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sv.body['token'], data: 'nope' }),
    });
    expect(sRes.status).toBe(403);
    expect(inputs).toEqual([]);

    // Invite share: unapproved input is 403; after approve, onInput fires.
    const created = await manager.createShare({ access: 'invite' });
    const v = await join(created, { name: 'Driver' });
    const token = v.body['token'] as string;
    const viewerId = v.body['viewerId'] as string;

    const before = await fetch(`${created.url}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, data: 'before-approve' }),
    });
    expect(before.status).toBe(403);
    expect(inputs).toEqual([]);

    await fetch(`${created.url}/request-join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    await control('/control/approve', {
      method: 'POST',
      body: JSON.stringify({ share: created.share.id, viewer: viewerId }),
    });
    expect(created.viewers.canWrite(viewerId)).toBe(true);

    const ok = await fetch(`${created.url}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, data: 'ls\r' }),
    });
    expect(ok.status).toBe(202);
    expect(inputs).toEqual([{ shareId: created.share.id, viewerId, data: 'ls\r' }]);

    // Payload cannot spoof identity — token stamps viewerId.
    const forged = await fetch(`${created.url}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, data: 'whoami', viewerId: 'someone-else' }),
    });
    expect(forged.status).toBe(202);
    expect(inputs[1]).toEqual({ shareId: created.share.id, viewerId, data: 'whoami' });
  });

  it('kick closes the viewer stream with a kicked event', async () => {
    const created = await manager.createShare();
    const v = await join(created);
    const stream = await fetch(`${created.url}/stream?token=${v.body['token']}`);
    const done = readSseUntilClose(stream);
    await control('/control/kick', {
      method: 'POST',
      body: JSON.stringify({ share: created.share.id, viewer: v.body['viewerId'] }),
    });
    const events = await done;
    expect(events.at(-1)?.event).toBe('kicked');
  });

  it('revoking the share ends streams with an ended event', async () => {
    const created = await manager.createShare();
    const v = await join(created);
    const stream = await fetch(`${created.url}/stream?token=${v.body['token']}`);
    const done = readSseUntilClose(stream);
    await created.revoke();
    const events = await done;
    expect(events.at(-1)?.event).toBe('ended');
    expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ state: 'revoked' });
  });

  it('watching count broadcasts as viewers come and go', async () => {
    const created = await manager.createShare();
    const v1 = await join(created);
    const stream1 = await fetch(`${created.url}/stream?token=${v1.body['token']}`);
    const first = await readSse(stream1, (ev) => ev.some((e) => e.event === 'viewers'));
    const countEvent = first.find((e) => e.event === 'viewers')!;
    expect(JSON.parse(countEvent.data).watching).toBeGreaterThanOrEqual(1);
  });

  it('broadcasts a named presence roster and stamps chat from the viewer token', async () => {
    const chats: Array<{ viewerId: string; name: string; text: string }> = [];
    // Rebuild transport with onChat so we can assert host-side delivery.
    await manager.stopAll();
    await transport.close();
    const consent = createConsentLedger();
    consent.grant(SHARE_SCOPE, 'test');
    transport = new LocalHttpTransport({
      hostToken: HOST_TOKEN,
      onChat: (_id, frame) => chats.push(frame),
    });
    await transport.listen();
    manager = new ShareManager({ consent, transport });
    base = `http://127.0.0.1:${transport.port}`;

    const created = await manager.createShare();
    const v1 = await join(created, { name: 'Ada\u001b[31m' }); // injection stripped at registry
    const v2 = await join(created, { name: 'Bob' });

    const stream2 = await fetch(`${created.url}/stream?token=${v2.body['token']}`);
    // Single SSE reader: wait for roster + chat (don't lock the body twice).
    const chatResP = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      return fetch(`${created.url}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: v1.body['token'],
          viewerId: 'forged',
          name: 'Eve',
          text: 'hello room\u001b[0m',
        }),
      });
    })();
    const events = await readSse(
      stream2,
      (ev) =>
        ev.some((e) => e.event === 'presence' || e.event === 'viewers') &&
        ev.some((e) => e.event === 'chat'),
    );
    const chatRes = await chatResP;
    expect(chatRes.status).toBe(202);

    const presence =
      events.find((e) => e.event === 'presence') ?? events.find((e) => e.event === 'viewers')!;
    const payload = JSON.parse(presence.data) as {
      watching: number;
      viewers: Array<{ viewerId: string; name: string; role: string }>;
    };
    expect(payload.watching).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.viewers)).toBe(true);
    expect(payload.viewers.some((r) => r.role === 'host')).toBe(true);
    const ada = payload.viewers.find((r) => r.viewerId === v1.body['viewerId']);
    expect(ada).toBeDefined();
    expect(ada!.name).not.toContain('\u001b');
    expect(ada!.name.startsWith('Ada')).toBe(true);

    // Chat: client forges identity fields; hub stamps from the token.
    const chat = JSON.parse(events.find((e) => e.event === 'chat')!.data) as Record<
      string,
      unknown
    >;
    expect(chat['viewerId']).toBe(v1.body['viewerId']); // connection/token-stamped
    expect(chat['name']).not.toBe('Eve');
    expect(String(chat['name'])).not.toContain('\u001b');
    expect(String(chat['text'])).not.toContain('\u001b');
    expect(String(chat['text'])).toContain('hello room');

    // Host callback saw the same stamped, sanitized line.
    expect(chats.length).toBe(1);
    expect(chats[0]!.viewerId).toBe(v1.body['viewerId']);
    expect(chats[0]!.text).toContain('hello room');
    expect(chats[0]!.text).not.toContain('\u001b');
  });

  it('control API requires the host token', async () => {
    const created = await manager.createShare();
    expect((await control(`/control/viewers?share=${created.share.id}`, undefined, null)).status).toBe(401);
    expect((await control(`/control/viewers?share=${created.share.id}`, undefined, 'wrong-token')).status).toBe(401);
    expect((await control(`/control/viewers?share=${created.share.id}`)).status).toBe(200);
  });

  it('control stop tears the share down (default handler)', async () => {
    const created = await manager.createShare();
    const res = await control('/control/stop', {
      method: 'POST',
      body: JSON.stringify({ share: created.share.id }),
    });
    expect(res.status).toBe(200);
    expect((await fetch(`${created.url}/meta`)).status).toBe(410);
    expect(created.feed.closed).toBe(true);
  });
});
