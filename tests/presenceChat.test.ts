/**
 * Pure presence + chat helpers: roster build, connection-stamped chat relay,
 * sanitizePeerText on names/chat, and e2e encrypt/decrypt of chat text.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2E_KEY_LEN, sanitizePeerText } from '@pooriaarab/vibe-core';
import {
  buildPresenceRoster,
  defaultPresenceName,
  sanitizePresenceName,
  stampChatRelay,
} from '../src/presenceChat.js';
import { decryptChatText, encryptChatText } from '../src/presenceChatCrypto.js';

describe('sanitizePresenceName', () => {
  it('strips terminal / bidi injection via sanitizePeerText', () => {
    const evil = 'Ada\u001b[31mRED\u202E\u0007';
    const cleaned = sanitizePresenceName(evil);
    expect(cleaned).toBe(sanitizePeerText(evil, 32).trim());
    expect(cleaned).not.toContain('\u001b');
    expect(cleaned).not.toContain('\u202E');
    expect(cleaned).not.toContain('\u0007');
  });

  it('caps length and trims', () => {
    expect(sanitizePresenceName(`  ${'x'.repeat(100)}  `).length).toBeLessThanOrEqual(32);
    expect(sanitizePresenceName(null)).toBe('');
    expect(sanitizePresenceName(42)).toBe('');
  });
});

describe('buildPresenceRoster', () => {
  it('builds a host-first roster with sanitized names', () => {
    const roster = buildPresenceRoster([
      { role: 'viewer', viewerId: 'v-b', name: 'Bob\u001b[0m' },
      { role: 'host', name: 'Host' },
      { role: 'viewer', viewerId: 'v-a', name: 'Ada' },
      { role: 'viewer' }, // missing viewerId — dropped
    ]);
    expect(roster.map((r) => r.role)).toEqual(['host', 'viewer', 'viewer']);
    expect(roster[0]).toMatchObject({ viewerId: 'host', name: 'Host', role: 'host' });
    expect(roster.find((r) => r.viewerId === 'v-a')?.name).toBe('Ada');
    expect(roster.find((r) => r.viewerId === 'v-b')?.name).not.toContain('\u001b');
  });

  it('fills default names when empty', () => {
    const roster = buildPresenceRoster([
      { role: 'host' },
      { role: 'viewer', viewerId: 'abcdef12-3456' },
    ]);
    expect(roster[0]?.name).toBe(defaultPresenceName('host', 'host'));
    expect(roster[1]?.name).toBe(defaultPresenceName('viewer', 'abcdef12-3456'));
  });
});

describe('stampChatRelay (attribution)', () => {
  it('stamps identity from the connection args, never the payload', () => {
    // Simulate a client that tried to forge viewerId/name in the payload —
    // stampChatRelay only receives CONNECTION identity from the hub.
    const stamped = stampChatRelay({
      viewerId: 'real-id',
      name: 'Real Ada',
      role: 'viewer',
      text: 'YWJjZGVmZ2hpamtsbW5vcA==',
      ts: 1_700_000_000_000,
    });
    expect(stamped).toEqual({
      kind: 'chat',
      viewerId: 'real-id',
      name: 'Real Ada',
      role: 'viewer',
      text: 'YWJjZGVmZ2hpamtsbW5vcA==',
      ts: 1_700_000_000_000,
    });
  });

  it('sanitizes the connection name and drops bad ciphertext', () => {
    const stamped = stampChatRelay({
      viewerId: 'v1',
      name: 'Eve\u001b[31m',
      role: 'viewer',
      text: 'okbase64==',
    });
    expect(stamped?.name).toBe(sanitizePeerText('Eve\u001b[31m', 32).trim());
    expect(stampChatRelay({ viewerId: 'v1', name: 'x', role: 'viewer', text: '' })).toBeNull();
    expect(stampChatRelay({ viewerId: 'v1', name: 'x', role: 'viewer', text: 'not base64!!!' })).toBeNull();
    expect(stampChatRelay({ viewerId: 'v1', name: 'x', role: 'viewer', text: 123 })).toBeNull();
  });
});

describe('chat text e2e', () => {
  it('encrypts with the share key; decrypt recovers sanitized plaintext', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const cipher = encryptChatText(key, 'hello from Ada');
    // Ciphertext is opaque base64 — not plaintext JSON / not the message.
    expect(cipher).not.toContain('hello from Ada');
    expect(() => JSON.parse(cipher)).toThrow();
    expect(decryptChatText(key, cipher)).toBe('hello from Ada');
  });

  it('strips injection from plaintext on encrypt AND decrypt', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const evil = 'hi\u001b[31mRED\u202E';
    const cipher = encryptChatText(key, evil);
    const plain = decryptChatText(key, cipher);
    expect(plain).toBe(sanitizePeerText(evil, 500));
    expect(plain).not.toContain('\u001b');
  });

  it('wrong key / tampered frame yields null (fail closed)', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const other = randomBytes(E2E_KEY_LEN);
    const cipher = encryptChatText(key, 'secret');
    expect(decryptChatText(other, cipher)).toBeNull();
    expect(decryptChatText(key, 'not-valid-frame')).toBeNull();
    // Tamper one byte of the base64-decoded frame.
    const buf = Buffer.from(cipher, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(decryptChatText(key, buf.toString('base64'))).toBeNull();
  });
});
