import { describe, expect, it } from 'vitest';
import { MAX_VIEWERS, atViewerCap, countViewers } from '../src/limits.js';

describe('constants (tunable)', () => {
  it('exposes the expected max-viewers default', () => {
    expect(MAX_VIEWERS).toBe(50);
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
