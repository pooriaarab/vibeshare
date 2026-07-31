/**
 * Host/Node-side chat e2e helpers (AES-GCM via vibe-core).
 * Kept separate from `presenceChat.ts` so the Cloudflare Worker can import
 * the pure roster/stamp helpers without pulling in Node `Buffer`.
 */
import { decryptFrame, encryptFrame, sanitizePeerText } from '@pooriaarab/vibe-core';

/** Cap on plaintext chat before encrypt (mirrors presenceChat.MAX_CHAT_PLAINTEXT_LEN). */
const MAX_CHAT_PLAINTEXT_LEN = 500;

/** Encrypt chat plaintext with the share key → base64 ciphertext for the wire. */
export function encryptChatText(key: Buffer, plaintext: string): string {
  const cleaned = sanitizePeerText(plaintext, MAX_CHAT_PLAINTEXT_LEN);
  const frame = encryptFrame(key, Buffer.from(cleaned, 'utf8'));
  return frame.toString('base64');
}

/**
 * Decrypt a chat wire ciphertext. Returns null on auth failure / bad input
 * (never throws — display path must fail closed).
 */
export function decryptChatText(key: Buffer, ciphertextB64: string): string | null {
  try {
    const frame = Buffer.from(ciphertextB64, 'base64');
    if (frame.length < 12 + 16) return null;
    const plain = decryptFrame(key, frame).toString('utf8');
    return sanitizePeerText(plain, MAX_CHAT_PLAINTEXT_LEN);
  } catch {
    return null;
  }
}
