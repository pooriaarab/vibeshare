/**
 * Host/Node-side annotation e2e helpers (AES-GCM via vibe-core).
 * Kept separate from `annotations.ts` so the Cloudflare Worker can import the
 * pure stamp/validate helpers without pulling in Node `Buffer` (mirrors
 * `presenceChatCrypto.ts`; same wire format, same share key).
 */
import { decryptFrame, encryptFrame, sanitizePeerText } from '@pooriaarab/vibe-core';
import { MAX_ANNOTATION_PLAINTEXT_LEN } from './annotations.js';

/** Encrypt annotation plaintext with the share key → base64 ciphertext for the wire. */
export function encryptAnnotationText(key: Buffer, plaintext: string): string {
  const cleaned = sanitizePeerText(plaintext, MAX_ANNOTATION_PLAINTEXT_LEN);
  const frame = encryptFrame(key, Buffer.from(cleaned, 'utf8'));
  return frame.toString('base64');
}

/**
 * Decrypt an annotation wire ciphertext. Returns null on auth failure / bad
 * input (never throws — display path must fail closed).
 */
export function decryptAnnotationText(key: Buffer, ciphertextB64: string): string | null {
  try {
    const frame = Buffer.from(ciphertextB64, 'base64');
    if (frame.length < 12 + 16) return null;
    const plain = decryptFrame(key, frame).toString('utf8');
    return sanitizePeerText(plain, MAX_ANNOTATION_PLAINTEXT_LEN);
  } catch {
    return null;
  }
}
