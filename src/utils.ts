/**
 * Small dependency-free primitives: capability ids, tokens, expiry parsing,
 * and passphrase hashing. All randomness is crypto-strength — share ids are
 * capability URLs, so they must be unguessable.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** A 12-char base64url id (72 bits of entropy) — unguessable, URL-safe. */
export function newShareId(): string {
  return randomBytes(9).toString('base64url');
}

/** A random hex token (viewer bearer tokens, host control token). */
export function newToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

const EXPIRY_RE = /^(\d+)(m|h|d)$/;

/**
 * Parse an expiry spec into milliseconds.
 *   'stop' | 'never'  → null (lasts until explicitly stopped)
 *   '<n>m' | '<n>h' | '<n>d' → that duration ('1h', '24h', '7d', …)
 * Anything else throws — callers (CLI) turn this into a usage error.
 */
export function parseExpiry(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (s === 'stop' || s === 'never' || s === 'until-stop') return null;
  const m = EXPIRY_RE.exec(s);
  if (!m) {
    throw new Error(`invalid expiry "${spec}" — use 1h, 24h, 7d, … or "stop"`);
  }
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`invalid expiry "${spec}" — duration must be positive`);
  }
  const unit = m[2];
  const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

/** Hash a passphrase for storage: `scrypt$<saltHex>$<hashHex>`. */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a candidate against a stored `scrypt$…` hash, timing-safe. */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = scryptSync(passphrase, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
