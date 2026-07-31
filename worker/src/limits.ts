/**
 * Pure, unit-tested hardening helpers for the ShareRoom Durable Object.
 *
 * Timing / cap constants live here so they stay tunable in a single place.
 * Fail CLOSED: callers should reject when these helpers say the limit is hit.
 */

/** Max simultaneous viewer sockets per share. Host is exempt. */
export const MAX_VIEWERS = 50;

/** Max new WebSocket upgrades per source IP within RATE_WINDOW_MS. */
export const MAX_CONN_PER_IP = 30;

/** Sliding window for the per-IP connection rate limit. */
export const RATE_WINDOW_MS = 60_000;

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

export interface RateLimitDecision {
  /** Whether this connection is allowed under the sliding window. */
  readonly allowed: boolean;
  /** Pruned (+ maybe appended) timestamps to store for this IP. */
  readonly timestamps: number[];
}

/**
 * Sliding-window rate limit: prune stamps older than the window, then accept
 * and record `now` if under the cap. Does not mutate the input array.
 *
 * Fail closed: at-or-over cap refuses and does not record the new attempt.
 */
export function recordConnection(
  timestamps: readonly number[],
  now: number,
  windowMs: number = RATE_WINDOW_MS,
  maxConn: number = MAX_CONN_PER_IP,
): RateLimitDecision {
  const pruned = timestamps.filter((t) => now - t < windowMs);
  if (pruned.length >= maxConn) {
    return { allowed: false, timestamps: pruned };
  }
  return { allowed: true, timestamps: [...pruned, now] };
}

/**
 * Drop empty / fully-expired IP entries from an in-memory rate-limit map.
 * Mutates the map in place.
 */
export function pruneRateLimitMap(
  map: Map<string, number[]>,
  now: number,
  windowMs: number = RATE_WINDOW_MS,
): void {
  for (const [ip, stamps] of map) {
    const pruned = stamps.filter((t) => now - t < windowMs);
    if (pruned.length === 0) map.delete(ip);
    else if (pruned.length !== stamps.length) map.set(ip, pruned);
  }
}
