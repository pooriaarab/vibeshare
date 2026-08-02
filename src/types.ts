/**
 * vibeshare — shared types.
 *
 * vibeshare is the URL / identity / access layer for sharing a live agent
 * coding session. It owns the *link and the gate*; the session content is an
 * ordered feed of entries that spectators receive live. vibelive (the
 * multiplayer engine) owns any future collaborator write path — see
 * `transport.ts` for that seam.
 */

/** Access policy for a share link. */
export type ShareAccess =
  /** Recipients can only watch. Genuinely read-only: there is no write route. */
  | 'spectate'
  /** Recipients may request to join; host approval promotes them to collaborator. */
  | 'invite';

export type ShareState = 'live' | 'revoked' | 'expired';

/** A live (or formerly live) share link. */
export interface Share {
  /** Unguessable capability id — appears in the URL. */
  readonly id: string;
  /** Human label, e.g. the command being shared or the agent name. */
  readonly name: string;
  access: ShareAccess;
  readonly createdAt: string;
  /** ISO timestamp, or null when the share lasts "until I stop". */
  readonly expiresAt: string | null;
  state: ShareState;
  /** scrypt hash (`scrypt$<salt>$<hash>`); never the plaintext passphrase. */
  readonly passphraseHash: string | null;
}

export type ViewerRole = 'spectator' | 'collaborator';

export type JoinRequestStatus = 'none' | 'pending' | 'approved' | 'denied';

/** Someone who opened the link and joined as a viewer. */
export interface Viewer {
  readonly id: string;
  name: string;
  role: ViewerRole;
  /** Bearer token issued at join; required for stream/request/leave calls. */
  readonly token: string;
  readonly joinedAt: string;
  joinRequest: JoinRequestStatus;
}

/** Ordered-log entry — re-exported from vibe-core (single source of truth). */
export type { FeedEntry } from '@pooriaarab/vibe-core/feed';

/** Options for creating a share (CLI, library, and MCP all funnel here). */
export interface CreateShareOptions {
  /** Label for what is being shared (command line, agent name, …). */
  readonly session?: string;
  /** Access policy. Default `'spectate'`. */
  readonly access?: ShareAccess;
  /**
   * How long the link lives: `'1h'`, `'24h'`, `'stop'` (until stopped), or
   * any `<n>m` / `<n>h` / `<n>d`. Default `'stop'`.
   */
  readonly expiry?: string;
  /** Passphrase second factor. Optional; stored only as a scrypt hash. */
  readonly passphrase?: string;
  /** Override the display name (defaults to `session`). */
  readonly name?: string;
  /**
   * Direct millisecond expiry override (takes precedence over `expiry`).
   * Mainly for tests and embedders that already hold a duration.
   */
  readonly expiryMs?: number;
}

/** vibeshare error with a machine-readable code (mapped to HTTP by transports). */
export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode, message: string) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
}

export type ShareErrorCode =
  | 'not-live'
  | 'not-found'
  | 'passphrase-required'
  | 'passphrase-invalid'
  | 'invite-disabled'
  | 'already-pending'
  | 'not-pending'
  | 'not-promoted'
  | 'consent-required'
  | 'bad-request';
