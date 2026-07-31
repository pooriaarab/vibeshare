/**
 * Shared end-to-end frame crypto — the one wire format used by both the
 * WebRTC DataChannel path and the tunnel/SSE path.
 *
 *   AES-256-GCM, per-frame nonce, wire layout:
 *     nonce(12) ‖ ciphertext ‖ tag(16)
 *
 * Pure and dependency-free (node:crypto only) so it can later move into
 * vibe-core without dragging transport code along.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256 key length in bytes. */
export const E2E_KEY_LEN = 32;
/** GCM nonce length in bytes (96-bit IV, NIST recommended for GCM). */
export const E2E_NONCE_LEN = 12;
/** GCM authentication tag length in bytes. */
export const E2E_TAG_LEN = 16;

/**
 * Encrypt one frame: `nonce ‖ ciphertext ‖ GCM tag`, with a fresh random
 * nonce per call. Exported so host transport code and tests share exactly
 * one wire format.
 */
export function encryptFrame(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(E2E_NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Decrypt one frame. Throws on truncation, a wrong key, or any tampering —
 * GCM authentication failure yields no plaintext, ever.
 */
export function decryptFrame(key: Buffer, frame: Buffer): Buffer {
  if (frame.length < E2E_NONCE_LEN + E2E_TAG_LEN) throw new Error('e2e frame too short');
  const nonce = frame.subarray(0, E2E_NONCE_LEN);
  const ciphertext = frame.subarray(E2E_NONCE_LEN, frame.length - E2E_TAG_LEN);
  const tag = frame.subarray(frame.length - E2E_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
