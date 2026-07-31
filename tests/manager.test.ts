import { afterEach, describe, expect, it } from 'vitest';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import { LocalHttpTransport } from '../src/localHttp.js';
import { ConsentRequiredError, ShareManager, SHARE_SCOPE } from '../src/manager.js';
import { verifyPassphrase } from '../src/utils.js';

function grantAll() {
  const consent = createConsentLedger();
  consent.grant(SHARE_SCOPE, 'test');
  return consent;
}

describe('ShareManager', () => {
  let transport: LocalHttpTransport;
  afterEach(async () => {
    await transport?.close();
  });

  const setup = (consent = grantAll()) => {
    transport = new LocalHttpTransport({});
    return new ShareManager({ consent, transport });
  };

  it('refuses to share without a share:session consent grant', async () => {
    const manager = setup(createConsentLedger());
    await expect(manager.createShare()).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(manager.createShare()).rejects.toMatchObject({ code: 'consent-required' });
  });

  it('creates a live share with a URL once consent is granted', async () => {
    const manager = setup();
    const created = await manager.createShare({ session: 'npm test', access: 'invite', expiry: '1h' });
    expect(created.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/${created.share.id}$`));
    expect(created.share.state).toBe('live');
    expect(created.share.access).toBe('invite');
    expect(created.share.name).toBe('npm test');
    expect(created.share.expiresAt).not.toBeNull();
    expect(manager.get(created.share.id)).toBe(created);
    expect(manager.list()).toHaveLength(1);
    // The log records the opening for late-joiner replay.
    const last = created.feed.backlog().at(-1);
    expect(last && 'text' in last ? last.text : '').toContain('share opened');
  });

  it('defaults to spectate, until-stopped, no passphrase', async () => {
    const manager = setup();
    const created = await manager.createShare();
    expect(created.share.access).toBe('spectate');
    expect(created.share.expiresAt).toBeNull();
    expect(created.share.passphraseHash).toBeNull();
  });

  it('stores passphrases hashed, verifiable, never plaintext', async () => {
    const manager = setup();
    const created = await manager.createShare({ passphrase: 'hunter2' });
    const stored = created.share.passphraseHash!;
    expect(stored).not.toContain('hunter2');
    expect(verifyPassphrase('hunter2', stored)).toBe(true);
    expect(verifyPassphrase('nope', stored)).toBe(false);
  });

  it('revoke ends the share: unserved, feed closed, state recorded', async () => {
    const manager = setup();
    const created = await manager.createShare();
    const id = created.share.id;
    await created.revoke();
    expect(created.share.state).toBe('revoked');
    expect(created.feed.closed).toBe(true);
    expect(manager.get(id)).toBeUndefined();
    expect(transport.shareCount).toBe(0);
    await created.revoke(); // idempotent
  });

  it('expiry auto-tears-down the share', async () => {
    const manager = setup();
    const created = await manager.createShare({ expiryMs: 40 });
    expect(created.share.state).toBe('live');
    await new Promise((r) => setTimeout(r, 200));
    expect(created.share.state).toBe('expired');
    expect(created.feed.closed).toBe(true);
    expect(transport.shareCount).toBe(0);
  });

  it('honours an explicit expiry duration over the spec string', async () => {
    const manager = setup();
    const created = await manager.createShare({ expiry: '24h', expiryMs: 30 });
    await new Promise((r) => setTimeout(r, 200));
    expect(created.share.state).toBe('expired');
  });

  it('rejects invalid expiry specs', async () => {
    const manager = setup();
    await expect(manager.createShare({ expiry: 'fortnight' })).rejects.toThrow(/invalid expiry/);
  });

  it('stopAll revokes everything and closes the transport', async () => {
    const manager = setup();
    await manager.createShare();
    await manager.createShare();
    expect(manager.list()).toHaveLength(2);
    await manager.stopAll();
    expect(manager.list()).toHaveLength(0);
    expect(transport.shareCount).toBe(0);
  });
});
