/**
 * Loopback host-control server used by --public shares so
 * `vibeshare viewers --approve` works without a spectator HTTP server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HostControlServer } from '../src/hostControl.js';
import { ViewerRegistry } from '../src/registry.js';

describe('HostControlServer', () => {
  let server: HostControlServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('lists viewers and approves a pending join under the stamped id', async () => {
    const stops: string[] = [];
    server = new HostControlServer({
      hostToken: 'ctrl-token',
      onStopRequested: (id) => stops.push(id),
    });
    await server.listen();

    const viewers = new ViewerRegistry(() => 'invite');
    const hubId = 'hub-id-cccc';
    viewers.ensure(hubId, 'Ada');
    viewers.requestJoin(hubId);
    server.track({ id: 'share-1', viewers });

    const base = `http://127.0.0.1:${server.port}`;
    const list = await fetch(`${base}/control/viewers?share=share-1`, {
      headers: { authorization: 'Bearer ctrl-token' },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      viewers: Array<{ id: string; joinRequest: string; role: string }>;
    };
    expect(body.viewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hubId, joinRequest: 'pending', role: 'spectator' }),
      ]),
    );

    const approve = await fetch(`${base}/control/approve`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ctrl-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ share: 'share-1', viewer: hubId }),
    });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as { viewer: { role: string } };
    expect(approved.viewer.role).toBe('collaborator');
    expect(viewers.canWrite(hubId)).toBe(true);

    // Stop notifies the callback.
    const stop = await fetch(`${base}/control/stop`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ctrl-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ share: 'share-1' }),
    });
    expect(stop.status).toBe(200);
    expect(stops).toEqual(['share-1']);
  });

  it('rejects non-loopback-style missing tokens', async () => {
    server = new HostControlServer({ hostToken: 'secret' });
    await server.listen();
    const res = await fetch(`http://127.0.0.1:${server.port}/control/viewers?share=x`);
    expect(res.status).toBe(401);
  });
});
