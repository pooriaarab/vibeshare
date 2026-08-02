/**
 * Presence + chat frame shapes and pure helpers shared by:
 *   - the signaling Worker (ShareRoom DO) — multi-party hub for --public
 *   - LocalHttpTransport — multi-party hub for local/tunnel SSE
 *   - WsSignaling host client + browser pages
 *   - unit tests (roster build, stamp-from-connection, sanitization)
 *
 * Identity rule (same as rtc frames): the hub STAMPS sender identity from
 * the CONNECTION attachment / viewer token. Client-supplied viewerId/name on
 * a chat payload are discarded. Message TEXT is end-to-end encrypted with the
 * share key (vibe-core encryptFrame); the hub only relays opaque ciphertext.
 *
 * This module is intentionally free of Node `Buffer` so the Cloudflare Worker
 * can import the pure helpers (roster / stamp / sanitize). Host-side
 * encrypt/decrypt live in `./presenceChatCrypto.ts`.
 */
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';

/** Cap on a display name stored in an attachment / registry. */
export const MAX_PRESENCE_NAME_LEN = 32;

/** Cap on plaintext chat before encrypt (defense in depth; UI also caps). */
export const MAX_CHAT_PLAINTEXT_LEN = 500;

/** Cap on base64 ciphertext length accepted on the wire. */
export const MAX_CHAT_CIPHERTEXT_LEN = 4_000;

export type PresenceRole = 'host' | 'viewer';

/** One row in a presence roster broadcast. */
export interface PresenceEntry {
  readonly viewerId: string;
  readonly name: string;
  readonly role: PresenceRole;
}

/** Hub → everyone: full roster snapshot. */
export interface PresenceFrame {
  readonly kind: 'presence';
  readonly viewers: readonly PresenceEntry[];
}

/**
 * Client → hub: set/rename this connection's display name.
 * The hub sanitizes and stores it on the connection attachment.
 */
export interface HelloFrame {
  readonly kind: 'hello';
  readonly name: string;
}

/**
 * Client → hub: send a chat line. `text` is base64(encryptFrame(shareKey, utf8)).
 * Any client-supplied identity fields are ignored by the hub.
 */
export interface ChatSendFrame {
  readonly kind: 'chat';
  readonly text: string;
}

/**
 * Hub → everyone: a chat line STAMPED with the connection's identity.
 * `text` remains ciphertext — the hub never decrypts it.
 */
export interface ChatRelayFrame {
  readonly kind: 'chat';
  readonly viewerId: string;
  readonly name: string;
  readonly role: PresenceRole;
  readonly text: string;
  readonly ts: number;
}

/**
 * Viewer → hub → host: request to drive an invite share.
 * The hub stamps viewerId from the CONNECTION — payload identity is discarded.
 */
export interface JoinRequestFrame {
  readonly kind: 'join-request';
  readonly viewerId: string;
  readonly name: string;
}

/**
 * Host → hub → one viewer: role / join-request decision.
 * Host is the only party allowed to emit this; hub stamps target from the
 * host-supplied viewerId (must match a live connection) and fans it out.
 */
export interface RoleUpdateFrame {
  readonly kind: 'role-update';
  readonly viewerId: string;
  /** 'collaborator' after approve; 'spectator' after deny. */
  readonly role: 'spectator' | 'collaborator';
  /** Mirrors Viewer.joinRequest after the decision. */
  readonly joinRequest: 'approved' | 'denied' | 'pending' | 'none';
}

export type PresenceChatInbound = HelloFrame | ChatSendFrame | { kind: 'join-request' };
export type PresenceChatOutbound = PresenceFrame | ChatRelayFrame | JoinRequestFrame | RoleUpdateFrame;

/** Sanitize a peer-supplied display name for storage/display. */
export function sanitizePresenceName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const cleaned = sanitizePeerText(name, MAX_PRESENCE_NAME_LEN).trim();
  return cleaned.slice(0, MAX_PRESENCE_NAME_LEN);
}

/** Default label when a peer has not sent a hello yet. */
export function defaultPresenceName(role: PresenceRole, viewerId: string): string {
  if (role === 'host') return 'host';
  const short = viewerId.replace(/-/g, '').slice(0, 6);
  return short.length > 0 ? `viewer-${short}` : 'viewer';
}

/** Build a roster snapshot from connection attachments (pure). */
export function buildPresenceRoster(
  attachments: ReadonlyArray<{
    role: PresenceRole;
    viewerId?: string;
    name?: string;
  }>,
): PresenceEntry[] {
  const out: PresenceEntry[] = [];
  for (const att of attachments) {
    if (att.role === 'host') {
      const name = sanitizePresenceName(att.name) || defaultPresenceName('host', 'host');
      out.push({ viewerId: 'host', name, role: 'host' });
      continue;
    }
    if (typeof att.viewerId !== 'string' || att.viewerId.length === 0) continue;
    const name =
      sanitizePresenceName(att.name) || defaultPresenceName('viewer', att.viewerId);
    out.push({ viewerId: att.viewerId, name, role: 'viewer' });
  }
  // Stable order: host first, then viewers by name then id.
  out.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.viewerId.localeCompare(b.viewerId);
  });
  return out;
}

/**
 * Stamp a chat relay frame from the CONNECTION identity + opaque ciphertext.
 * Returns null when the ciphertext is missing/invalid (hub drops it).
 */
export function stampChatRelay(opts: {
  readonly viewerId: string;
  readonly name: string;
  readonly role: PresenceRole;
  readonly text: unknown;
  readonly ts?: number;
}): ChatRelayFrame | null {
  if (typeof opts.text !== 'string') return null;
  const text = opts.text.trim();
  if (text.length === 0 || text.length > MAX_CHAT_CIPHERTEXT_LEN) return null;
  // Reject obvious non-base64 so we don't fan out garbage.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  const name =
    sanitizePresenceName(opts.name) || defaultPresenceName(opts.role, opts.viewerId);
  return {
    kind: 'chat',
    viewerId: opts.viewerId,
    name,
    role: opts.role,
    text,
    ts: opts.ts ?? Date.now(),
  };
}

/** Parse a client inbound presence/chat frame; null if not one of ours. */
export function parsePresenceChatInbound(msg: Record<string, unknown>): PresenceChatInbound | null {
  if (msg['kind'] === 'hello') {
    return { kind: 'hello', name: typeof msg['name'] === 'string' ? msg['name'] : '' };
  }
  if (msg['kind'] === 'chat' && typeof msg['text'] === 'string') {
    return { kind: 'chat', text: msg['text'] };
  }
  if (msg['kind'] === 'join-request') {
    return { kind: 'join-request' };
  }
  return null;
}

/** Build a host→viewer role-update frame (pure). */
export function buildRoleUpdate(opts: {
  readonly viewerId: string;
  readonly role: 'spectator' | 'collaborator';
  readonly joinRequest: 'approved' | 'denied' | 'pending' | 'none';
}): RoleUpdateFrame | null {
  if (typeof opts.viewerId !== 'string' || opts.viewerId.length === 0) return null;
  if (opts.role !== 'spectator' && opts.role !== 'collaborator') return null;
  if (
    opts.joinRequest !== 'approved' &&
    opts.joinRequest !== 'denied' &&
    opts.joinRequest !== 'pending' &&
    opts.joinRequest !== 'none'
  ) {
    return null;
  }
  return {
    kind: 'role-update',
    viewerId: opts.viewerId,
    role: opts.role,
    joinRequest: opts.joinRequest,
  };
}
