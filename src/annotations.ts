/**
 * Annotations — comments PINNED to a moment in the session (anchored to the
 * feed's monotonic seq), richer than ephemeral chat: threaded via `replyTo`.
 *
 * Frame shapes ride the SAME presence/chat hub (Worker ShareRoom for
 * --public, LocalHttpTransport SSE for local/tunnel) — this module only adds
 * the pure shapes/validation so the Worker can import them without Node
 * `Buffer` (mirrors `presenceChat.ts`; host-side e2e lives in
 * `./annotationsCrypto.ts`).
 *
 *   viewer → hub:  { kind:'annotation', seq, text, replyTo? }
 *   hub → all:     { kind:'annotation', id, seq, viewerId, name, role,
 *                    text, replyTo?, ts }
 *
 * Identity rule (identical to chat): the hub STAMPS viewerId/name/role from
 * the CONNECTION and mints the annotation `id`; client-supplied identity is
 * discarded. Only `seq` (the anchor) and `replyTo` (threading) pass through
 * from the payload — neither is identity. `text` is e2e ciphertext with the
 * share key on encrypted paths; the hub relays it opaque.
 */
import { sanitizePeerText } from '@pooriaarab/vibe-core';
import {
  defaultPresenceName,
  sanitizePresenceName,
  type PresenceRole,
} from './presenceChat.js';

/** Cap on plaintext annotation before encrypt (defense in depth; UI caps too). */
export const MAX_ANNOTATION_PLAINTEXT_LEN = 500;

/** Cap on base64 ciphertext length accepted on the wire (mirrors chat). */
export const MAX_ANNOTATION_CIPHERTEXT_LEN = 4_000;

/** Anchor seq must be an integer in [0, this] — it indexes the feed's seq. */
export const MAX_ANNOTATION_SEQ = 1_000_000_000;

/** Cap on annotation ids / replyTo references on the wire. */
export const MAX_ANNOTATION_ID_LEN = 64;

/** Cap on annotations held by a store (drop oldest beyond it). */
export const MAX_ANNOTATIONS_KEPT = 500;

/**
 * A pinned comment as viewers/host SEE it (post-decrypt, sanitized).
 */
export interface Annotation {
  readonly id: string;
  /** Anchor: the feed seq the author was looking at when pinning. */
  readonly seq: number;
  readonly authorViewerId: string;
  readonly authorName: string;
  readonly text: string;
  readonly createdAt: number;
  /** Parent annotation id when this is a threaded reply. */
  readonly replyTo?: string;
}

/**
 * Client → hub: pin a comment at `seq`. `text` is base64(encryptFrame(
 * shareKey, utf8)) on e2e paths, sanitized plaintext on the pure-local path.
 * Any client-supplied identity fields are ignored by the hub.
 */
export interface AnnotationSendFrame {
  readonly kind: 'annotation';
  readonly seq: number;
  readonly text: string;
  readonly replyTo?: string;
}

/**
 * Hub → everyone: an annotation STAMPED with the connection's identity and a
 * hub-minted id. `text` remains ciphertext on e2e paths — the hub never
 * decrypts it.
 */
export interface AnnotationRelayFrame {
  readonly kind: 'annotation';
  readonly id: string;
  readonly seq: number;
  readonly viewerId: string;
  readonly name: string;
  readonly role: PresenceRole;
  readonly text: string;
  readonly replyTo?: string;
  readonly ts: number;
}

/** Validate an anchor seq: a finite integer within range. Null when invalid. */
export function parseAnchorSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_ANNOTATION_SEQ) return null;
  return value;
}

/**
 * Normalize an optional replyTo reference. Absent/invalid simply drops
 * threading — the annotation itself still stands (replyTo is a hint, never
 * identity).
 */
export function normalizeReplyTo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ANNOTATION_ID_LEN) return undefined;
  return trimmed;
}

/** Parse a client inbound annotation frame; null when malformed. */
export function parseAnnotationSend(msg: Record<string, unknown>): AnnotationSendFrame | null {
  if (msg['kind'] !== 'annotation') return null;
  const seq = parseAnchorSeq(msg['seq']);
  if (seq === null) return null;
  if (typeof msg['text'] !== 'string' || msg['text'].length === 0) return null;
  if (msg['text'].length > MAX_ANNOTATION_CIPHERTEXT_LEN) return null;
  const replyTo = normalizeReplyTo(msg['replyTo']);
  return {
    kind: 'annotation',
    seq,
    text: msg['text'],
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

/**
 * Stamp an annotation relay frame from the CONNECTION identity + a hub-minted
 * id + the client's anchor seq and opaque ciphertext. Returns null when the
 * payload is invalid (hub drops it). Client-supplied identity never reaches
 * this function — callers pass connection identity only.
 */
export function stampAnnotation(opts: {
  readonly id: string;
  readonly viewerId: string;
  readonly name: string;
  readonly role: PresenceRole;
  readonly seq: unknown;
  readonly text: unknown;
  readonly replyTo?: unknown;
  readonly ts?: number;
}): AnnotationRelayFrame | null {
  if (typeof opts.id !== 'string' || opts.id.length === 0 || opts.id.length > MAX_ANNOTATION_ID_LEN) {
    return null;
  }
  const seq = parseAnchorSeq(opts.seq);
  if (seq === null) return null;
  if (typeof opts.text !== 'string') return null;
  const text = opts.text.trim();
  if (text.length === 0 || text.length > MAX_ANNOTATION_CIPHERTEXT_LEN) return null;
  // Reject obvious non-base64 so we don't fan out garbage (e2e wire format).
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  const name =
    sanitizePresenceName(opts.name) || defaultPresenceName(opts.role, opts.viewerId);
  const replyTo = normalizeReplyTo(opts.replyTo);
  return {
    kind: 'annotation',
    id: opts.id,
    seq,
    viewerId: opts.viewerId,
    name,
    role: opts.role,
    text,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ts: opts.ts ?? Date.now(),
  };
}

/** Validate a decrypted annotation for display/storage. Null when invalid. */
export function validateAnnotation(raw: unknown): Annotation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a['id'] !== 'string' || a['id'].length === 0 || a['id'].length > MAX_ANNOTATION_ID_LEN) {
    return null;
  }
  const seq = parseAnchorSeq(a['seq']);
  if (seq === null) return null;
  if (typeof a['authorViewerId'] !== 'string' || a['authorViewerId'].length === 0) return null;
  if (typeof a['text'] !== 'string') return null;
  const text = sanitizePeerText(a['text'], MAX_ANNOTATION_PLAINTEXT_LEN);
  if (text.trim().length === 0) return null;
  const authorName =
    sanitizePresenceName(a['authorName']) ||
    defaultPresenceName('viewer', a['authorViewerId']);
  const createdAt =
    typeof a['createdAt'] === 'number' && Number.isFinite(a['createdAt'])
      ? a['createdAt']
      : Date.now();
  const replyTo = normalizeReplyTo(a['replyTo']);
  return {
    id: a['id'],
    seq,
    authorViewerId: a['authorViewerId'],
    authorName,
    text,
    createdAt,
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

/**
 * A small in-memory annotation store (the "persistence" half of
 * chat-with-a-seq-anchor): dedupe by id, ordered listing, thread resolution.
 * Orphan replies (parent not in the store) surface as roots so a reply never
 * vanishes when its parent arrived on a hub the store didn't see.
 */
export class AnnotationStore {
  readonly #byId = new Map<string, Annotation>();

  /** Validate + insert. Returns the stored annotation, or null when invalid/duplicate. */
  add(raw: unknown): Annotation | null {
    const annotation = validateAnnotation(raw);
    if (!annotation) return null;
    if (this.#byId.has(annotation.id)) return null;
    this.#byId.set(annotation.id, annotation);
    if (this.#byId.size > MAX_ANNOTATIONS_KEPT) {
      const oldest = this.#byId.keys().next().value;
      if (oldest !== undefined) this.#byId.delete(oldest);
    }
    return annotation;
  }

  get(id: string): Annotation | undefined {
    return this.#byId.get(id);
  }

  get size(): number {
    return this.#byId.size;
  }

  /** All annotations, ordered by anchor seq, then time, then id (stable). */
  list(): Annotation[] {
    return [...this.#byId.values()].sort(compareAnnotations);
  }

  /** Top-level pins: no replyTo, or a replyTo whose parent isn't stored. */
  roots(): Annotation[] {
    return this.list().filter((a) => a.replyTo === undefined || !this.#byId.has(a.replyTo));
  }

  /** Direct replies to `id`, oldest first. */
  replies(id: string): Annotation[] {
    return this.list().filter((a) => a.replyTo === id);
  }

  /**
   * A thread view: the root plus its direct replies. When `id` names a reply,
   * resolves up to its root first. Null when the id is unknown.
   */
  thread(id: string): { root: Annotation; replies: Annotation[] } | null {
    let current = this.#byId.get(id);
    if (!current) return null;
    // Walk up (bounded) so a reply id yields the whole thread.
    for (let depth = 0; current.replyTo !== undefined && depth < 32; depth++) {
      const parent = this.#byId.get(current.replyTo);
      if (!parent) break;
      current = parent;
    }
    return { root: current, replies: this.replies(current.id) };
  }
}

function compareAnnotations(a: Annotation, b: Annotation): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}
