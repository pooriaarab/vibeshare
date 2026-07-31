import { describe, expect, it } from 'vitest';
import {
  ABANDONED_CLEANUP_MS,
  MAX_CONN_PER_IP,
  MAX_SHARE_LIFE_MS,
  MAX_VIEWERS,
  RATE_WINDOW_MS,
  abandonedCleanupDeadline,
  atViewerCap,
  countViewers,
  earliestAlarm,
  hostActivityDeadline,
  pruneRateLimitMap,
  recordConnection,
} from '../src/limits.js';

describe('constants (tunable)', () => {
  it('exposes the expected max-viewers, rate-limit, and cleanup defaults', () => {
    expect(MAX_VIEWERS).toBe(50);
    expect(MAX_CONN_PER_IP).toBe(30);
    expect(RATE_WINDOW_MS).toBe(60_000);
    expect(MAX_SHARE_LIFE_MS).toBe(24 * 60 * 60 * 1000);
    expect(ABANDONED_CLEANUP_MS).toBe(60_000);
  });
});

describe('countViewers / atViewerCap', () => {
  it('counts only viewer roles', () => {
    expect(countViewers([])).toBe(0);
    expect(countViewers(['host'])).toBe(0);
    expect(countViewers(['viewer', 'host', 'viewer'])).toBe(2);
  });

  it('is under cap while count < MAX_VIEWERS', () => {
    expect(atViewerCap(0)).toBe(false);
    expect(atViewerCap(MAX_VIEWERS - 1)).toBe(false);
  });

  it('fail-closed at and above the cap', () => {
    expect(atViewerCap(MAX_VIEWERS)).toBe(true);
    expect(atViewerCap(MAX_VIEWERS + 5)).toBe(true);
  });

  it('respects an override max', () => {
    expect(atViewerCap(2, 2)).toBe(true);
    expect(atViewerCap(1, 2)).toBe(false);
  });
});

describe('recordConnection (sliding window)', () => {
  const windowMs = 1_000;
  const maxConn = 3;

  it('allows the first connection and records it', () => {
    const r = recordConnection([], 10_000, windowMs, maxConn);
    expect(r.allowed).toBe(true);
    expect(r.timestamps).toEqual([10_000]);
  });

  it('prunes stamps outside the window', () => {
    const r = recordConnection([1_000, 9_500], 10_000, windowMs, maxConn);
    expect(r.allowed).toBe(true);
    expect(r.timestamps).toEqual([9_500, 10_000]);
  });

  it('fail-closed when at the cap inside the window', () => {
    const stamps = [9_200, 9_500, 9_800];
    const r = recordConnection(stamps, 10_000, windowMs, maxConn);
    expect(r.allowed).toBe(false);
    expect(r.timestamps).toEqual(stamps);
  });

  it('does not record a rejected attempt', () => {
    const stamps = [9_200, 9_500, 9_800];
    const r = recordConnection(stamps, 10_000, windowMs, maxConn);
    expect(r.allowed).toBe(false);
    expect(r.timestamps).not.toContain(10_000);
  });

  it('allows again once old stamps slide out of the window', () => {
    const stamps = [8_000, 8_100, 8_200]; // all older than window at t=10_000
    const r = recordConnection(stamps, 10_000, windowMs, maxConn);
    expect(r.allowed).toBe(true);
    expect(r.timestamps).toEqual([10_000]);
  });

  it('does not mutate the input array', () => {
    const input = [9_500];
    const r = recordConnection(input, 10_000, windowMs, maxConn);
    expect(input).toEqual([9_500]);
    expect(r.timestamps).not.toBe(input);
  });

  it('uses the module defaults (30 / 60s)', () => {
    const nearCap = Array.from({ length: MAX_CONN_PER_IP }, (_, i) => 1_000 + i);
    const blocked = recordConnection(nearCap, 1_000 + RATE_WINDOW_MS - 1);
    expect(blocked.allowed).toBe(false);
    const open = recordConnection(nearCap, 1_000 + RATE_WINDOW_MS);
    expect(open.allowed).toBe(true);
  });
});

describe('pruneRateLimitMap', () => {
  it('removes empty IPs and prunes stale stamps', () => {
    const map = new Map<string, number[]>([
      ['a', [1]],
      ['b', [9_500, 1]],
      ['c', [9_900]],
    ]);
    pruneRateLimitMap(map, 10_000, 1_000);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toEqual([9_500]);
    expect(map.get('c')).toEqual([9_900]);
  });
});

describe('deadline helpers', () => {
  it('hostActivityDeadline adds MAX_SHARE_LIFE_MS', () => {
    expect(hostActivityDeadline(1_000)).toBe(1_000 + MAX_SHARE_LIFE_MS);
  });

  it('abandonedCleanupDeadline adds ABANDONED_CLEANUP_MS', () => {
    expect(abandonedCleanupDeadline(1_000)).toBe(1_000 + ABANDONED_CLEANUP_MS);
  });

  it('earliestAlarm picks the minimum finite candidate', () => {
    expect(earliestAlarm()).toBeNull();
    expect(earliestAlarm(undefined, null)).toBeNull();
    expect(earliestAlarm(50, 10, 20)).toBe(10);
    expect(earliestAlarm(NaN, 5)).toBe(5);
  });
});

