/**
 * Pure, unit-tested hardening helpers for the ShareRoom Durable Object.
 *
 * Timing / cap constants live here so they stay tunable in a single place.
 * Fail CLOSED: callers should reject when these helpers say the limit is hit.
 */

/** Max simultaneous viewer sockets per share. Host is exempt. */
export const MAX_VIEWERS = 50;

/** Count viewer roles in a list of socket roles. */
export function countViewers(roles: readonly ('host' | 'viewer')[]): number {
  let n = 0;
  for (const role of roles) {
    if (role === 'viewer') n += 1;
  }
  return n;
}

/**
 * True when a new viewer must be refused (already at cap).
 * Fail closed: count >= max is blocked.
 */
export function atViewerCap(viewerCount: number, maxViewers: number = MAX_VIEWERS): boolean {
  return viewerCount >= maxViewers;
}
