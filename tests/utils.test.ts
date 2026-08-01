import { describe, expect, it } from 'vitest';
import { hashPassphrase, newShareId, newToken, parseExpiry, verifyPassphrase } from '../src/utils.js';

describe('newShareId', () => {
  it('is URL-safe and 12 chars (72 bits of entropy)', () => {
    const id = newShareId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('never collides across a batch', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newShareId()));
    expect(ids.size).toBe(2000);
  });

  it('never starts with - or _ (would parse as a CLI flag)', () => {
    for (let i = 0; i < 3000; i++) {
      expect(newShareId()).not.toMatch(/^[-_]/);
    }
  });

  it('is the single canonical definition (utils.js), not duplicated in url.js', async () => {
    // Audit finding: url.ts and utils.ts used to BOTH define newShareId with
    // different entropy. utils.ts is canonical; url.ts must not re-grow one.
    const urlModule = await import('../src/url.js');
    expect('newShareId' in urlModule).toBe(false);
    const indexModule = await import('../src/index.js');
    expect(indexModule.newShareId).toBe(newShareId);
  });
});

describe('newToken', () => {
  it('is hex of the requested length', () => {
    expect(newToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken(4)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parseExpiry', () => {
  it('parses durations', () => {
    expect(parseExpiry('30m')).toBe(30 * 60_000);
    expect(parseExpiry('1h')).toBe(3_600_000);
    expect(parseExpiry('24h')).toBe(86_400_000);
    expect(parseExpiry('7d')).toBe(7 * 86_400_000);
  });

  it('parses "until I stop" spellings as null', () => {
    expect(parseExpiry('stop')).toBeNull();
    expect(parseExpiry('never')).toBeNull();
    expect(parseExpiry('until-stop')).toBeNull();
    expect(parseExpiry(' STOP ')).toBeNull();
  });

  it('is case-insensitive for durations', () => {
    expect(parseExpiry('2H')).toBe(7_200_000);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '10', '0h', '-3h', '1w', 'h', '1.5h']) {
      expect(() => parseExpiry(bad), bad).toThrow(/invalid expiry/);
    }
  });
});

describe('passphrase hashing', () => {
  it('stores a scrypt hash, not plaintext', () => {
    const stored = hashPassphrase('river-otter-42');
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain('river-otter-42');
  });

  it('verifies the right passphrase and rejects wrong ones', () => {
    const stored = hashPassphrase('correct horse');
    expect(verifyPassphrase('correct horse', stored)).toBe(true);
    expect(verifyPassphrase('wrong horse', stored)).toBe(false);
    expect(verifyPassphrase('', stored)).toBe(false);
  });

  it('uses a random salt per hash', () => {
    expect(hashPassphrase('same')).not.toBe(hashPassphrase('same'));
  });

  it('rejects malformed stored hashes', () => {
    expect(verifyPassphrase('x', 'not-a-hash')).toBe(false);
    expect(verifyPassphrase('x', 'md5$aa$bb')).toBe(false);
  });
});
