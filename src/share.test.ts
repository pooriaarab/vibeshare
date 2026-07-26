import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import { createRelay, createWriteArbiter, SHARE_SESSION_SCOPE } from 'vibelive-cli';
import type { RelayHandle } from 'vibelive-cli';
import { ConsentError, createShare, parseExpiry } from './share.js';
import { buildShareUrl, parseShareUrl } from './url.js';

describe('parseExpiry', () => {
  it('maps presets and raw durations to milliseconds', () => {
    expect(parseExpiry(undefined)).toBeNull();
    expect(parseExpiry('1h')).toBe(60 * 60 * 1000);
    expect(parseExpiry('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseExpiry(5_000)).toBe(5_000);
  });

  it('rejects non-positive / non-finite raw durations', () => {
    expect(() => parseExpiry(0)).toThrow(RangeError);
    expect(() => parseExpiry(-10)).toThrow(RangeError);
    expect(() => parseExpiry(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

/** A minimal duck-typed vibelive relay for pure (no-network) share-logic tests. */
function stubRelay(opts: { grant?: boolean; closeCalls?: { n: number } } = {}): RelayHandle {
  const consent = createConsentLedger();
  if (opts.grant !== false) consent.grant(SHARE_SESSION_SCOPE);
  const closeCalls = opts.closeCalls ?? { n: 0 };
  const relay = {
    port: 0,
    url: 'ws://localhost:0',
    consent,
    arbiter: createWriteArbiter('host'),
    participants: [] as unknown[],
    emitOutput: () => {},
    broadcastOutput: () => {},
    localRequestControl: () => {},
    localReleaseControl: () => {},
    localLeave: () => {},
    close: async () => {
      closeCalls.n++;
    },
    closed: new Promise<void>(() => {}), // never resolves in tests
  };
  return relay as unknown as RelayHandle;
}

describe('createShare — consent gate', () => {
  it('refuses to mint a share without the share:session consent grant', () => {
    const relay = stubRelay({ grant: false });
    expect(() => createShare({ session: relay })).toThrow(ConsentError);
  });

  it('mints a share once share:session is granted', () => {
    const relay = stubRelay();
    const share = createShare({ session: relay });
    expect(share.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(share.url).toBe(buildShareUrl(share.id));
  });
});

describe('createShare — expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-revokes (closing the relay) when the expiry elapses', () => {
    vi.useFakeTimers();
    const closeCalls = { n: 0 };
    const relay = stubRelay({ closeCalls });

    let revokedReason: string | undefined;
    const share = createShare({
      session: relay,
      expiry: 1_000, // 1s in ms
      onRevoke: (reason) => {
        revokedReason = reason;
      },
    });

    expect(share.revoked).toBe(false);
    expect(closeCalls.n).toBe(0);

    vi.advanceTimersByTime(999);
    expect(share.revoked).toBe(false); // not yet

    vi.advanceTimersByTime(2); // past 1000ms
    expect(share.revoked).toBe(true);
    expect(closeCalls.n).toBe(1); // relay torn down
    expect(revokedReason).toBe('expired');
  });

  it('never expires when no expiry is given', () => {
    vi.useFakeTimers();
    const relay = stubRelay();
    const share = createShare({ session: relay });
    vi.advanceTimersByTime(60 * 60 * 1000 * 24);
    expect(share.revoked).toBe(false);
  });

  it('manual revoke clears the expiry timer (idempotent teardown)', () => {
    vi.useFakeTimers();
    const closeCalls = { n: 0 };
    const relay = stubRelay({ closeCalls });
    const share = createShare({ session: relay, expiry: 1_000 });
    void share.revoke();
    expect(share.revoked).toBe(true);
    expect(closeCalls.n).toBe(1);
    vi.advanceTimersByTime(5_000); // expiry would have fired — must be cleared
    expect(closeCalls.n).toBe(1); // no double-close
  });
});

// One fast, non-flaky ws integration test: bind a real ephemeral relay (no client
// connects), mint a share over it, round-trip the URL, and revoke. Exercises the
// real createShare ↔ createRelay wiring without any socket handshake timing.
describe('createShare — real ephemeral relay integration', () => {
  it('round-trips url/id, reports an empty audience, and revokes cleanly', async () => {
    const relay = await createRelay({
      port: 0,
      initialDriver: 'host',
      hostParticipantName: 'host',
    });
    try {
      const share = createShare({
        session: relay,
        access: 'spectate',
        expiry: '1h',
      });

      // parseShareUrl must round-trip createShare's url.
      expect(parseShareUrl(share.url).id).toBe(share.id);
      expect(share.url).toMatch(/^https:\/\/vibeshare\.stream\/s\//);
      expect(share.relayUrl).toBe(relay.url);
      expect(share.access).toBe('spectate');

      // No remote viewers connected yet → empty roster (host isn't a viewer).
      const roster = share.viewers();
      expect(roster.viewers).toEqual([]);
      expect(roster.pending).toEqual([]);

      expect(share.revoked).toBe(false);
      await share.revoke();
      expect(share.revoked).toBe(true);
    } finally {
      await relay.close();
    }
  });
});
