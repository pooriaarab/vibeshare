/**
 * Annotations: pure validation + store (anchor seq, threading), connection-
 * stamped relay frames, e2e encrypt/decrypt of annotation text, and the
 * LocalHttpTransport hub route (plaintext + e2e wire).
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsentLedger,
  decryptFrame,
  E2E_KEY_LEN,
  sanitizePeerText,
} from '@pooriaarab/vibe-core';
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
import { LocalHttpTransport } from '../src/localHttp.js';
import { ShareManager, SHARE_SCOPE, type CreatedShare } from '../src/manager.js';
import { readSse } from './helpers.js';

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


// ---------------------------------------------------------------------------
// Hub integration: POST /s/:id/annotate through LocalHttpTransport.
// ---------------------------------------------------------------------------

interface AnnCallback {
  viewerId: string;
  name: string;
  seq: number;
  text: string;
  replyTo?: string;
}

describe('LocalHttpTransport annotation hub (plaintext path)', () => {
  let transport: LocalHttpTransport;
  let manager: ShareManager;
  let anns: AnnCallback[];

  beforeEach(async () => {
    const consent = createConsentLedger();
    consent.grant(SHARE_SCOPE, 'test');
    anns = [];
    transport = new LocalHttpTransport({
      hostToken: 'ann-host-token',
      onAnnotation: (_id, frame) => anns.push(frame),
    });
    await transport.listen();
    manager = new ShareManager({ consent, transport });
  });

  afterEach(async () => {
    await manager.stopAll();
    await transport.close();
  });

  const join = async (created: CreatedShare, name: string) => {
    const res = await fetch(`${created.url}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('stamps sender from the token, anchors seq, keeps replyTo, sanitizes text', async () => {
    const created = await manager.createShare();
    const v1 = await join(created, 'Ada[31m');
    const v2 = await join(created, 'Bob');
    const stream2 = await fetch(`${created.url}/stream?token=${v2.body['token']}`);

    const postP = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      return fetch(`${created.url}/annotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: v1.body['token'],
          id: 'forged-id',
          viewerId: 'forged',
          name: 'Eve',
          seq: 137,
          replyTo: 'parent-1',
          text: 'this moment is broken[0m',
        }),
      });
    })();
    const events = await readSse(stream2, (ev) => ev.some((e) => e.event === 'annotation'));
    const res = await postP;
    expect(res.status).toBe(202);

    const ann = JSON.parse(events.find((e) => e.event === 'annotation')!.data) as Record<string, unknown>;
    expect(ann['kind']).toBe('annotation');
    // Hub-minted id + token-stamped identity — forged fields discarded.
    expect(ann['id']).not.toBe('forged-id');
    expect(typeof ann['id']).toBe('string');
    expect(ann['viewerId']).toBe(v1.body['viewerId']);
    expect(String(ann['name'])).not.toBe('Eve');
    expect(String(ann['name'])).not.toContain('');
    // Anchor + threading pass through.
    expect(ann['seq']).toBe(137);
    expect(ann['replyTo']).toBe('parent-1');
    // Plaintext path relays sanitized text.
    expect(String(ann['text'])).toContain('this moment is broken');
    expect(String(ann['text'])).not.toContain('');
    expect(typeof ann['ts']).toBe('number');

    // Host callback saw the same stamped, sanitized annotation.
    expect(anns.length).toBe(1);
    expect(anns[0]).toMatchObject({
      viewerId: v1.body['viewerId'],
      seq: 137,
      replyTo: 'parent-1',
    });
    expect(anns[0]!.text).toContain('this moment is broken');
  });

  it('rejects bad anchor, empty text, and unknown tokens', async () => {
    const created = await manager.createShare();
    const v1 = await join(created, 'Ada');
    const post = (body: Record<string, unknown>) =>
      fetch(`${created.url}/annotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ token: v1.body['token'], seq: -1, text: 'x' })).status).toBe(400);
    expect((await post({ token: v1.body['token'], text: 'x' })).status).toBe(400);
    expect((await post({ token: v1.body['token'], seq: 1, text: '   ' })).status).toBe(400);
    expect((await post({ token: 'nope', seq: 1, text: 'x' })).status).toBe(401);
    expect(anns.length).toBe(0);
  });
});

describe('LocalHttpTransport annotation hub (e2e path)', () => {
  it('relays ciphertext opaque; stamped identity + seq survive; host gets plaintext', async () => {
    const consent = createConsentLedger();
    consent.grant(SHARE_SCOPE, 'test');
    const key = randomBytes(E2E_KEY_LEN);
    const anns: AnnCallback[] = [];
    const transport = new LocalHttpTransport({
      hostToken: 'ann-e2e-token',
      e2e: { key },
      onAnnotation: (_id, frame) => anns.push(frame),
    });
    await transport.listen();
    const manager = new ShareManager({ consent, transport });
    try {
      const created = await manager.createShare();
      const url = created.url.split('#')[0]!;
      const joinRes = await fetch(`${url}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Maya' }),
      });
      const viewer = (await joinRes.json()) as Record<string, unknown>;
      const stream = await fetch(`${url}/stream?token=${viewer['token']}`);

      const cipher = encryptAnnotationText(key, 'pin this exact frame');
      expect(cipher).not.toContain('pin this exact frame');

      const wait = readSse(stream, (ev) => ev.some((e) => e.event === 'annotation'));
      const res = await fetch(`${url}/annotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: viewer['token'],
          viewerId: 'forged',
          name: 'Eve',
          seq: 88,
          text: cipher,
        }),
      });
      expect(res.status).toBe(202);
      const events = await wait;

      const annEv = events.find((e) => e.event === 'annotation')!;
      // Outer SSE envelope is e2e-encrypted too.
      expect(() => JSON.parse(annEv.data)).toThrow();
      const envelope = JSON.parse(
        decryptFrame(key, Buffer.from(annEv.data, 'base64')).toString('utf8'),
      ) as Record<string, unknown>;
      expect(envelope['kind']).toBe('annotation');
      expect(envelope['viewerId']).toBe(viewer['viewerId']); // stamped
      expect(envelope['name']).not.toBe('Eve');
      expect(envelope['seq']).toBe(88);
      // Inner text is STILL ciphertext (double-blind for the tunnel provider).
      expect(String(envelope['text'])).not.toContain('pin this exact frame');
      expect(decryptAnnotationText(key, String(envelope['text']))).toBe('pin this exact frame');

      // Host callback received decrypted plaintext with the anchor.
      expect(anns).toEqual([
        expect.objectContaining({
          viewerId: viewer['viewerId'],
          seq: 88,
          text: 'pin this exact frame',
        }),
      ]);
    } finally {
      await manager.stopAll();
      await transport.close();
    }
  });
});
