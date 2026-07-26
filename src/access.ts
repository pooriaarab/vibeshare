/**
 * The access gate — the correctness-critical piece of vibeshare.
 *
 * Background (docs/spec.md · "Access / safety"): a shared link carries an access
 * policy. **Spectators** are read-only: they see the live agent output stream but
 * can never drive the wrapped agent. **Invite** viewers may be promoted to a full
 * vibelive participant (request control → drive).
 *
 * The invariant vibeshare adds on top of vibelive:
 *
 *   > A spectator NEVER obtains the write token.
 *
 * We do NOT enforce this in the UI only. We enforce it by never letting a
 * spectator reach the write-arbitration state machine: the gate swallows their
 * `requestControl` and returns `null` (denied) without touching the arbiter, so a
 * spectator is never the driver and never enters the FIFO queue. The same
 * `WriteArbiter` vibelive uses to guarantee "never two concurrent writers" is the
 * witness we assert against (see `src/access.test.ts`): after a spectator request,
 * `arbiter.isDriver(spectatorId) === false` and the queue does not contain them.
 *
 * This module is pure logic over an injected arbiter — no IO, no network — so the
 * invariant is fully unit-testable.
 */
import type { ControlState, WriteArbiter } from 'vibelive-cli';

/** Who a share link lets its holders do. */
export type AccessMode = 'spectate' | 'invite';

/** Default access when a share is created without an explicit policy. */
export const DEFAULT_ACCESS: AccessMode = 'spectate';

/** The role a particular viewer currently holds inside a share. */
export type ViewerRole = 'spectator' | 'participant';

/** Denial reasons surfaced to callers / tests. */
export type DenialReason =
  | 'spectator' // read-only access — spectators can never drive
  | 'not-promoted' // invite viewer who hasn't been approved into participant role yet
  | 'unknown'; // viewer id not recognized by this gate

/** Result of a (possibly-denied) control request. */
export type ControlRequestResult =
  | { readonly ok: true; readonly state: ControlState }
  | { readonly ok: false; readonly reason: DenialReason };

export interface AccessGateOptions {
  /** The real vibelive write-arbiter the gate mediates. */
  readonly arbiter: WriteArbiter;
  /** The share's access policy. */
  readonly access?: AccessMode;
  /**
   * Optional passphrase. When set, `verifyPassphrase` must pass before a viewer is
   * admitted at all (a second factor on top of the capability URL).
   */
  readonly passphrase?: string;
}

/**
 * The access gate. Owns the per-viewer role bookkeeping and mediates every write
 * request through the injected vibelive {@link WriteArbiter}. Stateless w.r.t. the
 * network — the CLI/MCP wire viewers in and call `requestControl`/`approve`.
 */
export interface AccessGate {
  /** This share's access policy. */
  readonly access: AccessMode;
  /** True iff a passphrase is required to join this share. */
  readonly hasPassphrase: boolean;
  /** Admit a new viewer (recorded at the share's default role). Idempotent. */
  admit(viewer: { readonly id: string; readonly name: string }, passphrase?: string): boolean;
  /** Remove a viewer (e.g. on disconnect / kick). Releases the token if they hold it. */
  remove(viewerId: string): void;
  /** True iff this viewer id is known to the gate. */
  has(viewerId: string): boolean;
  /** This viewer's current role, or `undefined` if unknown. */
  role(viewerId: string): ViewerRole | undefined;
  /**
   * Promote an invite viewer into a full participant (eligible to drive).
   * Only meaningful under `access: 'invite'`. Returns false if the viewer is
   * unknown or the share is spectate-only.
   */
  promote(viewerId: string): boolean;
  /**
   * Request the write token on behalf of a viewer.
   *
   * - Spectators (any share) → denied (`reason: 'spectator'`), arbiter untouched.
   * - Invite viewers not yet promoted → denied (`reason: 'not-promoted'`).
   * - Promoted invite viewers → forwards to the arbiter and returns its snapshot.
   *
   * This is the single chokepoint that upholds "a spectator never obtains the
   * write token" against the real vibelive arbiter.
   */
  requestControl(viewerId: string): ControlRequestResult;
}

export function createAccessGate(options: AccessGateOptions): AccessGate {
  const access = options.access ?? DEFAULT_ACCESS;
  const arbiter = options.arbiter;
  const passphrase = options.passphrase;
  // role per viewer id. Spectators stay 'spectator'; promoted invitees become 'participant'.
  const roles = new Map<string, ViewerRole>();

  const hasPassphrase = typeof passphrase === 'string' && passphrase.length > 0;

  return {
    access,
    hasPassphrase,
    admit({ id }, input) {
      if (hasPassphrase && input !== passphrase) return false;
      // First-admit role: spectators (spectate share) start read-only; invite
      // viewers also start as 'spectator' until the host promotes them — a join
      // request is "let me in", promotion is a separate host action.
      if (!roles.has(id)) roles.set(id, 'spectator');
      return true;
    },
    remove(id) {
      roles.delete(id);
      // Release the token if they were driving (FIFO hand-off to next waiter).
      arbiter.leave(id);
    },
    has: (id) => roles.has(id),
    role: (id) => roles.get(id),
    promote(id) {
      if (access !== 'invite') return false;
      if (!roles.has(id)) return false;
      roles.set(id, 'participant');
      return true;
    },
    requestControl(id) {
      // The invariant: a spectator never reaches the arbiter.
      const role = roles.get(id);
      if (role === undefined) return { ok: false, reason: 'unknown' };
      if (role === 'participant') {
        const state = arbiter.requestControl(id);
        return { ok: true, state };
      }
      // Not a participant. The reason depends on whether promotion is even
      // possible: an invite share can still elevate them (`not-promoted`); a
      // spectate share never can (`spectator`).
      return { ok: false, reason: access === 'invite' ? 'not-promoted' : 'spectator' };
    },
  };
}
