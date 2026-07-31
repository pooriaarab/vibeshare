/**
 * Opt-in e2e mode on LocalHttpTransport: SSE payloads are AES-GCM frames,
 * decryptable with the per-share key from the URL #fragment. Default local
 * path (no e2e) stays plaintext — covered by transport.test.ts.
 */
import { createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsentLedger,
  decryptFrame,
  encryptFrame,
  E2E_KEY_LEN,
  E2E_NONCE_LEN,
  E2E_TAG_LEN,
} from '@pooriaarab/vibe-core';
import { LocalHttpTransport } from '../src/localHttp.js';
import { ShareManager, SHARE_SCOPE, type CreatedShare } from '../src/manager.js';
import { spectatorPage } from '../src/spectatorPage.js';
import { readSse } from './helpers.js';

/** Mirror the spectator page / viewerPage.ts WebCrypto-shaped decrypt in node. */
function webCryptoShapedDecrypt(key: Buffer, frame: Buffer): Buffer {
  // WebCrypto takes (iv=nonce, data=ciphertext‖tag) — same as AES-GCM here.
  if (frame.length < E2E_NONCE_LEN + E2E_TAG_LEN) throw new Error('short');
  const nonce = frame.subarray(0, E2E_NONCE_LEN);
  const ctAndTag = frame.subarray(E2E_NONCE_LEN);
  const ciphertext = ctAndTag.subarray(0, ctAndTag.length - E2E_TAG_LEN);
  const tag = ctAndTag.subarray(ctAndTag.length - E2E_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

describe('e2e pure frame crypto', () => {
  it('round-trips and rejects tampering', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const frame = encryptFrame(key, Buffer.from('hello e2e', 'utf8'));
    expect(decryptFrame(key, frame).toString('utf8')).toBe('hello e2e');
    expect(webCryptoShapedDecrypt(key, frame).toString('utf8')).toBe('hello e2e');
    const tampered = Buffer.from(frame);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decryptFrame(key, tampered)).toThrow();
    expect(() => webCryptoShapedDecrypt(key, tampered)).toThrow();
  });
});

describe('LocalHttpTransport e2e SSE mode', () => {
  let transport: LocalHttpTransport;
  let manager: ShareManager;
  let key: Buffer;

  beforeEach(async () => {
    const consent = createConsentLedger();
    consent.grant(SHARE_SCOPE, 'test');
    key = randomBytes(E2E_KEY_LEN);
    transport = new LocalHttpTransport({ hostToken: 'e2e-host-token', e2e: { key } });
    await transport.listen();
    manager = new ShareManager({ consent, transport });
  });

  afterEach(async () => {
    await manager.stopAll();
    await transport.close();
  });

  const join = async (created: CreatedShare) => {
    // URL carries #<key>; strip it for HTTP.
    const url = created.url.split('#')[0]!;
    const res = await fetch(`${url}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Maya' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, url };
  };

  it('appends the key as a base64url #fragment on the share URL', async () => {
    const created = await manager.createShare({ name: 'e2e-demo' });
    expect(transport.e2eEnabled).toBe(true);
    const [path, fragment] = created.url.split('#');
    expect(path).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+$/);
    expect(fragment).toBe(key.toString('base64url'));
  });

  it('serves the e2e spectator page variant that decrypts via WebCrypto', async () => {
    const created = await manager.createShare({ name: 'e2e-demo' });
    const url = created.url.split('#')[0]!;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('tunnel · end-to-end encrypted');
    expect(html).toContain('AES-GCM');
    expect(html).toContain('location.hash');
    expect(html).toContain('"e2e":true');
    // xterm.js is inlined (CSP-safe) — no CDN script tags.
    expect(html).toContain('new Terminal');
    expect(html).toMatch(/\.xterm[^{]*\{/); // xterm CSS present
    expect(html).not.toMatch(/src=["']https?:\/\//);
    // And the pure helper produces the same shape.
    expect(spectatorPage(created.share, { e2e: true })).toContain('tunnel · end-to-end encrypted');
    expect(spectatorPage(created.share)).not.toContain('tunnel · end-to-end encrypted');
  });

  it('encrypts SSE entry payloads; WebCrypto-shaped decrypt recovers JSON', async () => {
    const created = await manager.createShare();
    created.feed.publish('secret line', { stream: 'stdout' });
    created.feed.publishRaw(Buffer.from('\x1b[32mGREEN\x1b[0m', 'utf8'));
    created.feed.publishResize(100, 30);

    const v = await join(created);
    expect(v.status).toBe(200);
    const stream = await fetch(`${v.url}/stream?token=${v.body['token']}`);
    expect(stream.status).toBe(200);

    const events = await readSse(stream, (ev) => ev.filter((e) => e.event === 'entry').length >= 4);
    const entries = events.filter((e) => e.event === 'entry');
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const decoded = entries.map((ev) => {
      // Must NOT be plaintext JSON.
      expect(() => JSON.parse(ev.data)).toThrow();
      const frame = Buffer.from(ev.data, 'base64');
      const plain = webCryptoShapedDecrypt(key, frame);
      return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
    });

    expect(decoded.some((o) => o['text'] === 'secret line')).toBe(true);
    const raw = decoded.find((o) => o['type'] === 'raw');
    expect(raw).toBeDefined();
    expect(Buffer.from(String(raw!['data']), 'base64').toString('utf8')).toBe('\x1b[32mGREEN\x1b[0m');
    expect(decoded.some((o) => o['type'] === 'resize' && o['cols'] === 100 && o['rows'] === 30)).toBe(true);

    // Wrong key yields nothing.
    const wrong = randomBytes(E2E_KEY_LEN);
    expect(() => decryptFrame(wrong, Buffer.from(entries[0]!.data, 'base64'))).toThrow();
  });

  it('encrypts non-entry SSE events too (viewers count)', async () => {
    const created = await manager.createShare();
    const v = await join(created);
    const stream = await fetch(`${v.url}/stream?token=${v.body['token']}`);
    const events = await readSse(stream, (ev) => ev.some((e) => e.event === 'viewers'));
    const viewers = events.find((e) => e.event === 'viewers')!;
    expect(() => JSON.parse(viewers.data)).toThrow();
    const plain = decryptFrame(key, Buffer.from(viewers.data, 'base64'));
    expect(JSON.parse(plain.toString('utf8'))).toMatchObject({ watching: expect.any(Number) });
  });
});

