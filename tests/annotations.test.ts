/**
 * Annotations: pure validation + store (anchor seq, threading), connection-
 * stamped relay frames, and e2e encrypt/decrypt of annotation text.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2E_KEY_LEN, sanitizePeerText } from '@pooriaarab/vibe-core';
import {
  AnnotationStore,
  MAX_ANNOTATION_PLAINTEXT_LEN,
  MAX_ANNOTATION_SEQ,
  normalizeReplyTo,
  parseAnchorSeq,
  parseAnnotationSend,
  stampAnnotation,
  validateAnnotation,
  type Annotation,
} from '../src/annotations.js';
import { decryptAnnotationText, encryptAnnotationText } from '../src/annotationsCrypto.js';

const B64 = 'YWJjZGVmZ2hpamtsbW5vcA==';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    seq: 42,
    authorViewerId: 'viewer-1',
    authorName: 'Ada',
    text: 'pin this moment',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('parseAnchorSeq', () => {
  it('accepts non-negative integers within range, rejects the rest', () => {
    expect(parseAnchorSeq(0)).toBe(0);
    expect(parseAnchorSeq(1234)).toBe(1234);
    expect(parseAnchorSeq(MAX_ANNOTATION_SEQ)).toBe(MAX_ANNOTATION_SEQ);
    expect(parseAnchorSeq(-1)).toBeNull();
    expect(parseAnchorSeq(1.5)).toBeNull();
    expect(parseAnchorSeq(MAX_ANNOTATION_SEQ + 1)).toBeNull();
    expect(parseAnchorSeq('42')).toBeNull();
    expect(parseAnchorSeq(undefined)).toBeNull();
    expect(parseAnchorSeq(Number.NaN)).toBeNull();
  });
});

describe('parseAnnotationSend', () => {
  it('parses kind/seq/text and normalizes replyTo', () => {
    expect(parseAnnotationSend({ kind: 'annotation', seq: 7, text: 'abc', replyTo: ' ann-1 ' })).toEqual({
      kind: 'annotation',
      seq: 7,
      text: 'abc',
      replyTo: 'ann-1',
    });
    expect(parseAnnotationSend({ kind: 'annotation', seq: 7, text: 'abc' })).toEqual({
      kind: 'annotation',
      seq: 7,
      text: 'abc',
    });
  });

  it('rejects wrong kind, bad anchor, empty/oversized text', () => {
    expect(parseAnnotationSend({ kind: 'chat', seq: 7, text: 'abc' })).toBeNull();
    expect(parseAnnotationSend({ kind: 'annotation', seq: 'x', text: 'abc' })).toBeNull();
    expect(parseAnnotationSend({ kind: 'annotation', seq: 7, text: '' })).toBeNull();
    expect(parseAnnotationSend({ kind: 'annotation', seq: 7, text: 42 })).toBeNull();
    expect(parseAnnotationSend({ kind: 'annotation', seq: 7, text: 'x'.repeat(4001) })).toBeNull();
  });
});

describe('stampAnnotation (attribution + anchor)', () => {
  it('stamps identity from connection args + keeps the anchor seq', () => {
    const stamped = stampAnnotation({
      id: 'ann-9',
      viewerId: 'real-id',
      name: 'Real Ada',
      role: 'viewer',
      seq: 123,
      text: B64,
      ts: 1_700_000_000_000,
    });
    expect(stamped).toEqual({
      kind: 'annotation',
      id: 'ann-9',
      seq: 123,
      viewerId: 'real-id',
      name: 'Real Ada',
      role: 'viewer',
      text: B64,
      ts: 1_700_000_000_000,
    });
  });

  it('keeps a valid replyTo and drops a malformed one', () => {
    const withReply = stampAnnotation({
      id: 'a1', viewerId: 'v', name: 'n', role: 'viewer', seq: 1, text: B64, replyTo: 'parent-1',
    });
    expect(withReply?.replyTo).toBe('parent-1');
    const badReply = stampAnnotation({
      id: 'a1', viewerId: 'v', name: 'n', role: 'viewer', seq: 1, text: B64, replyTo: 42,
    });
    expect(badReply?.replyTo).toBeUndefined();
  });

  it('sanitizes the connection name and drops bad ciphertext/anchor/id', () => {
    const stamped = stampAnnotation({
      id: 'a1', viewerId: 'v1', name: 'Eve\u001b[31m', role: 'viewer', seq: 3, text: 'okbase64==',
    });
    expect(stamped?.name).toBe(sanitizePeerText('Eve\u001b[31m', 32).trim());
    const base = { id: 'a1', viewerId: 'v1', name: 'x', role: 'viewer' as const, seq: 3, text: B64 };
    expect(stampAnnotation({ ...base, text: '' })).toBeNull();
    expect(stampAnnotation({ ...base, text: 'not base64!!!' })).toBeNull();
    expect(stampAnnotation({ ...base, text: 123 })).toBeNull();
    expect(stampAnnotation({ ...base, seq: -1 })).toBeNull();
    expect(stampAnnotation({ ...base, seq: '3' })).toBeNull();
    expect(stampAnnotation({ ...base, id: '' })).toBeNull();
  });
});

describe('validateAnnotation', () => {
  it('sanitizes text and names; requires a non-empty clean text', () => {
    const evil = makeAnnotation({
      id: 'ann-e',
      authorName: 'Eve\u001b[31m\u202E',
      text: 'look here\u0007\u202E',
    });
    const valid = validateAnnotation(evil);
    expect(valid).not.toBeNull();
    expect(valid!.text).toBe(sanitizePeerText('look here\u0007\u202E', MAX_ANNOTATION_PLAINTEXT_LEN));
    expect(valid!.authorName).not.toContain('\u001b[31m');
    expect(validateAnnotation(makeAnnotation({ text: '\u0007' }))).toBeNull();
    expect(validateAnnotation(makeAnnotation({ seq: -5 }))).toBeNull();
    expect(validateAnnotation(makeAnnotation({ id: '' }))).toBeNull();
    expect(validateAnnotation('nope')).toBeNull();
  });

  it('caps text length and keeps replyTo when well-formed', () => {
    const long = validateAnnotation(makeAnnotation({ text: 'y'.repeat(900) }));
    expect(long!.text.length).toBeLessThanOrEqual(MAX_ANNOTATION_PLAINTEXT_LEN);
    const reply = validateAnnotation(makeAnnotation({ replyTo: 'parent-7' }));
    expect(reply?.replyTo).toBe('parent-7');
  });
});

describe('AnnotationStore', () => {
  it('adds, dedupes by id, and lists ordered by anchor seq then time', () => {
    const store = new AnnotationStore();
    expect(store.add(makeAnnotation({ id: 'b', seq: 50 }))).not.toBeNull();
    expect(store.add(makeAnnotation({ id: 'a', seq: 10 }))).not.toBeNull();
    expect(store.add(makeAnnotation({ id: 'c', seq: 50, createdAt: 1_700_000_000_500 }))).not.toBeNull();
    // Duplicate id ignored.
    expect(store.add(makeAnnotation({ id: 'b', seq: 999 }))).toBeNull();
    expect(store.size).toBe(3);
    expect(store.list().map((a) => a.id)).toEqual(['a', 'b', 'c']);
    // Invalid never lands.
    expect(store.add({ id: 'x' })).toBeNull();
    expect(store.size).toBe(3);
  });

  it('threads: roots, replies, and thread() resolution from any member', () => {
    const store = new AnnotationStore();
    store.add(makeAnnotation({ id: 'root', seq: 10, text: 'root pin' }));
    store.add(makeAnnotation({ id: 'r1', seq: 10, text: 'first reply', replyTo: 'root', createdAt: 1_700_000_000_100 }));
    store.add(makeAnnotation({ id: 'r2', seq: 12, text: 'second reply', replyTo: 'root', createdAt: 1_700_000_000_200 }));
    store.add(makeAnnotation({ id: 'other', seq: 99, text: 'unrelated' }));

    expect(store.roots().map((a) => a.id)).toEqual(['root', 'other']);
    expect(store.replies('root').map((a) => a.id)).toEqual(['r1', 'r2']);

    const fromRoot = store.thread('root');
    expect(fromRoot?.root.id).toBe('root');
    expect(fromRoot?.replies.map((a) => a.id)).toEqual(['r1', 'r2']);
    // Asking for a reply resolves up to the same thread.
    const fromReply = store.thread('r1');
    expect(fromReply?.root.id).toBe('root');
    expect(store.thread('missing')).toBeNull();
  });

  it('surfaces orphan replies (unknown parent) as roots so they never vanish', () => {
    const store = new AnnotationStore();
    store.add(makeAnnotation({ id: 'orphan', seq: 5, replyTo: 'ghost' }));
    expect(store.roots().map((a) => a.id)).toEqual(['orphan']);
    expect(store.replies('ghost').map((a) => a.id)).toEqual(['orphan']);
  });
});

describe('normalizeReplyTo', () => {
  it('trims, caps, and drops non-strings', () => {
    expect(normalizeReplyTo(' abc ')).toBe('abc');
    expect(normalizeReplyTo('')).toBeUndefined();
    expect(normalizeReplyTo('   ')).toBeUndefined();
    expect(normalizeReplyTo(7)).toBeUndefined();
    expect(normalizeReplyTo('x'.repeat(65))).toBeUndefined();
  });
});

describe('annotation text e2e', () => {
  it('encrypts with the share key; decrypt recovers sanitized plaintext', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const cipher = encryptAnnotationText(key, 'pin at this exact line');
    expect(cipher).not.toContain('pin at this exact line');
    expect(() => JSON.parse(cipher)).toThrow();
    expect(decryptAnnotationText(key, cipher)).toBe('pin at this exact line');
  });

  it('strips injection on encrypt AND decrypt', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const evil = 'pin\u001b[31mRED\u202E';
    const cipher = encryptAnnotationText(key, evil);
    const plain = decryptAnnotationText(key, cipher);
    expect(plain).toBe(sanitizePeerText(evil, MAX_ANNOTATION_PLAINTEXT_LEN));
    expect(plain).not.toContain('\u001b');
  });

  it('wrong key / tampered frame yields null (fail closed)', () => {
    const key = randomBytes(E2E_KEY_LEN);
    const other = randomBytes(E2E_KEY_LEN);
    const cipher = encryptAnnotationText(key, 'secret pin');
    expect(decryptAnnotationText(other, cipher)).toBeNull();
    expect(decryptAnnotationText(key, 'not-valid-frame')).toBeNull();
    const buf = Buffer.from(cipher, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(decryptAnnotationText(key, buf.toString('base64'))).toBeNull();
  });
});
