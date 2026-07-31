/**
 * The share orchestrator — the public library surface.
 *
 * vibeshare is the URL/access layer ON TOP of vibelive's engine: it does not
 * reimplement transport. {@link createShare} takes an already-running vibelive
 * relay (the host's local/LAN ws server) and mints a capability URL + access gate
 * + expiry around it. Spectators connect to the relay as ordinary vibelive
 * participants (they get the ordered output fan-out) but the access gate ensures
 * they can never drive the wrapped agent.
 *
 * Consent: vibeshare gates fanning session output off the host machine behind the
 * `share:session` scope from `@pooriaarab/vibe-core`. `createShare` refuses to
 * mint a share unless that grant is present (the CLI grants it; a bare library
 * caller must too), which is the same local-first enforcement vibelive uses.
 */
import type { RelayHandle, Participant } from 'vibelive';
import { SHARE_SESSION_SCOPE as VIBELIVE_SHARE_SCOPE } from 'vibelive';
import type { ConsentLedger } from '@pooriaarab/vibe-core';
import type { AccessMode } from './access.js';
import { createAccessGate, type AccessGate, type ViewerRole } from './access.js';
import { buildShareUrl } from './url.js';
import { newShareId } from './utils.js';

/** The consent scope that gates sharing a session off the host machine. */
export const SHARE_SESSION_SCOPE = VIBELIVE_SHARE_SCOPE;

/** Expiry specification: a preset, or a raw duration in milliseconds. */
export type ExpirySpec = '1h' | '24h' | number;

/**
 * Parse an expiry spec into a duration in milliseconds, or `null` for "never".
 *
 * Pure and total — unit-tested directly. `undefined` → never expires.
 */
export function parseExpiry(spec: ExpirySpec | undefined): number | null {
  if (spec === undefined) return null;
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec) || spec <= 0) {
      throw new RangeError(`expiry duration must be a positive finite number (ms), got: ${spec}`);
    }
    return Math.floor(spec);
  }
  switch (spec) {
    case '1h':
      return 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    default: {
      // Exhaustiveness guard: if ExpirySpec grows a preset, this errors at compile time.
      const exhaustive: never = spec;
      throw new RangeError(`unknown expiry preset: ${String(exhaustive)}`);
    }
  }
}

/** A viewer of a share, derived from the live vibelive roster + the access gate. */
export interface Viewer {
  readonly id: string;
  readonly name: string;
  /** Current role — spectators can't drive; participants can. */
  readonly role: ViewerRole;
  readonly joinedAt: number;
}

/** A snapshot of a share's audience. */
export interface ViewerRoster {
  readonly viewers: readonly Viewer[];
  /** Invite viewers awaiting host promotion (join requests). */
  readonly pending: readonly Viewer[];
}

/** Why a share tore down. Surfaced via {@link ShareOptions.onRevoke}. */
export type RevokeReason = 'manual' | 'expired';

export interface ShareOptions {
  /** The running vibelive relay whose session is being shared. */
  readonly session: RelayHandle;
  /** Access policy for link holders. Defaults to spectate (read-only). */
  readonly access?: AccessMode;
  /** Optional expiry (auto-revokes the share after this elapses). */
  readonly expiry?: ExpirySpec;
  /** Optional passphrase — a second factor on top of the capability URL. */
  readonly passphrase?: string;
  /**
   * Optional explicit consent ledger. Defaults to the relay's own ledger, which
   * vibelive seeds with `share:session` granted. If you pass a different ledger it
   * must hold the grant or `createShare` throws.
   */
  readonly consent?: ConsentLedger;
  /** Called exactly once when the share tears down (manual revoke or expiry). */
  readonly onRevoke?: (reason: RevokeReason) => void;
}

export interface ShareHandle {
  /** The unguessable capability id backing this share. */
  readonly id: string;
  /** The human-facing share URL (`https://vibeshare.stream/s/<id>`). */
  readonly url: string;
  /** This share's access policy. */
  readonly access: AccessMode;
  /** True once revoked (manually or by expiry). */
  readonly revoked: boolean;
  /** The underlying access gate (exposed for tests + advanced callers). */
  readonly gate: AccessGate;
  /** The local/LAN relay URL viewers actually connect over. */
  readonly relayUrl: string;
  /** Live audience snapshot: connected viewers + pending join requests. */
  viewers(): ViewerRoster;
  /**
   * Promote a pending invite viewer into a participant (lets them request control).
   * Invite shares only. Returns false if unknown / spectate share.
   */
  approve(viewerId: string): boolean;
  /** Remove a viewer (disconnect handling / kick). Releases the token if held. */
  removeViewer(viewerId: string): void;
  /** Tear down the share: clear the expiry timer and close the vibelive relay. */
  revoke(): Promise<void>;
}

/** Error thrown when consent for `share:session` has not been granted. */
export class ConsentError extends Error {
  constructor() {
    super(`consent for "${SHARE_SESSION_SCOPE}" is required to share a session — grant it first`);
    this.name = 'ConsentError';
  }
}

const HOST_PARTICIPANT_NAME = 'host';

function isLocalHostParticipant(p: Participant): boolean {
  // vibelive tags the local host-user participant (the one with no `ws`) as the
  // host; remote spectators/invitees carry a websocket. We exclude the local host
  // from the "viewers" roster — they're the one sharing, not watching.
  return p.ws === undefined;
}

function participantName(p: Participant, fallback: string): string {
  return p.name && p.name.length > 0 ? p.name : fallback;
}

export function createShare(options: ShareOptions): ShareHandle {
  const relay = options.session;
  const consent = options.consent ?? relay.consent;
  if (!consent.allows(SHARE_SESSION_SCOPE)) {
    throw new ConsentError();
  }

  const id = newShareId();
  const url = buildShareUrl(id);
  const gate = createAccessGate({
    arbiter: relay.arbiter,
    access: options.access,
    passphrase: options.passphrase,
  });

  const firstSeen = new Map<string, number>();
  const noteSeen = (pid: string): number => {
    let t = firstSeen.get(pid);
    if (t === undefined) {
      t = Date.now();
      firstSeen.set(pid, t);
    }
    return t;
  };

  let revoked = false;
  let revokeReason: RevokeReason | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const fireRevoke = (reason: RevokeReason): Promise<void> => {
    if (revoked) return Promise.resolve();
    revoked = true;
    revokeReason = reason;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    try {
      options.onRevoke?.(reason);
    } catch {
      // a misbehaving callback never blocks teardown
    }
    return relay.close().catch(() => {
      // best-effort: a relay that's already closed is fine
    });
  };

  const expiryMs = parseExpiry(options.expiry);
  if (expiryMs !== null) {
    expiryTimer = setTimeout(() => {
      void fireRevoke('expired');
    }, expiryMs);
    // Don't keep the Node event loop alive solely for an expiry timer when the
    // share is being driven by a long-lived host process anyway — but DO unref so
    // tests / short-lived callers can exit cleanly.
    expiryTimer.unref?.();
  }

  const toViewer = (p: Participant): Viewer => {
    const pid = p.id;
    // Keep the gate's roster in sync with whoever is actually connected.
    if (!gate.has(pid)) {
      gate.admit({ id: pid, name: participantName(p, pid) });
    }
    const role = gate.role(pid) ?? 'spectator';
    return {
      id: pid,
      name: participantName(p, pid),
      role,
      joinedAt: noteSeen(pid),
    };
  };

  return {
    id,
    url,
    access: gate.access,
    gate,
    relayUrl: relay.url,
    get revoked() {
      return revoked;
    },
    viewers() {
      const connected: Viewer[] = [];
      const pending: Viewer[] = [];
      for (const p of relay.participants) {
        if (isLocalHostParticipant(p)) continue; // host isn't a viewer
        const v = toViewer(p);
        // Pending = invite viewers who haven't been promoted to participant yet.
        if (gate.access === 'invite' && v.role !== 'participant') {
          pending.push(v);
        } else {
          connected.push(v);
        }
      }
      return { viewers: connected, pending };
    },
    approve(viewerId) {
      return gate.promote(viewerId);
    },
    removeViewer(viewerId) {
      gate.remove(viewerId);
    },
    revoke() {
      return fireRevoke(revokeReason === 'expired' ? 'expired' : 'manual');
    },
  };
}

export { HOST_PARTICIPANT_NAME };
