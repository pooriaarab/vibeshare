import { describe, expect, it } from 'vitest';
import { createWriteArbiter } from '@pooriaarab/vibelive';
import { createAccessGate } from './access.js';

/**
 * The headline invariant of vibeshare: a spectator NEVER obtains the write token.
 * We assert it against the REAL vibelive WriteArbiter — the same state machine
 * vibelive uses to guarantee "never two concurrent writers". After a spectator's
 * request, the arbiter must show the spectator as neither driver nor queued.
 */
describe('access gate — spectator enforcement', () => {
  it('denies a spectator and never touches the arbiter (no driver, no queue)', () => {
    const arbiter = createWriteArbiter('host'); // host is driving
    const gate = createAccessGate({ arbiter, access: 'spectate' });

    // A spectator is admitted read-only (this is the spectator path).
    expect(gate.admit({ id: 'spect-1', name: 'watcher' })).toBe(true);

    const res = gate.requestControl('spect-1');

    // Denied as a spectator specifically.
    expect(res).toEqual({ ok: false, reason: 'spectator' });

    // The invariant, witnessed against the real arbiter:
    expect(arbiter.isDriver('spect-1')).toBe(false); // never granted
    expect(arbiter.queue()).not.toContain('spect-1'); // never even queued
    expect(arbiter.driver()).toBe('host'); // host unaffected
  });

  it('a spectator stays locked out across many requests (no promotion path exists)', () => {
    const arbiter = createWriteArbiter('host');
    const gate = createAccessGate({ arbiter, access: 'spectate' });
    gate.admit({ id: 's', name: 's' });
    for (let i = 0; i < 5; i++) {
      expect(gate.requestControl('s')).toEqual({ ok: false, reason: 'spectator' });
    }
    expect(arbiter.isDriver('s')).toBe(false);
    expect(arbiter.driver()).toBe('host');
  });
});

describe('access gate — invite promotion', () => {
  it('an invite viewer starts read-only and only drives once the host promotes them', () => {
    const arbiter = createWriteArbiter('host');
    const gate = createAccessGate({ arbiter, access: 'invite' });
    gate.admit({ id: 'ada', name: 'ada' });

    // Before promotion: denied as not-yet-promoted (NOT as a permanent spectator).
    expect(gate.requestControl('ada')).toEqual({ ok: false, reason: 'not-promoted' });

    // Host hands off control first, then promotes — now ada can actually drive.
    arbiter.release('host'); // idle now
    expect(gate.promote('ada')).toBe(true);
    expect(gate.role('ada')).toBe('participant');

    const res = gate.requestControl('ada');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.driverId).toBe('ada');
    }
    // Witnessed against the real arbiter:
    expect(arbiter.isDriver('ada')).toBe(true);
  });

  it('invite viewers queue FIFO through the real arbiter once promoted', () => {
    const arbiter = createWriteArbiter('host');
    const gate = createAccessGate({ arbiter, access: 'invite' });
    for (const id of ['a', 'b']) gate.admit({ id, name: id });
    gate.promote('a');
    gate.promote('b');

    const r1 = gate.requestControl('a'); // host still driving → a queued
    const r2 = gate.requestControl('b'); // b queued behind a
    expect(r1.ok && r1.state.queue).toContain('a');
    expect(r2.ok && r2.state.queue).toEqual(['a', 'b']);
    expect(arbiter.driver()).toBe('host');

    arbiter.release('host'); // FIFO hand-off → a becomes driver
    expect(arbiter.driver()).toBe('a');
  });

  it('promotion is impossible under spectate-only access', () => {
    const arbiter = createWriteArbiter('host');
    const gate = createAccessGate({ arbiter, access: 'spectate' });
    gate.admit({ id: 'x', name: 'x' });
    expect(gate.promote('x')).toBe(false);
    expect(gate.role('x')).toBe('spectator');
  });
});

describe('access gate — membership + passphrase', () => {
  it('reports unknown viewers as unknown on control requests', () => {
    const gate = createAccessGate({ arbiter: createWriteArbiter('host'), access: 'invite' });
    expect(gate.requestControl('ghost')).toEqual({ ok: false, reason: 'unknown' });
    expect(gate.has('ghost')).toBe(false);
  });

  it('requires a matching passphrase to admit a viewer', () => {
    const gate = createAccessGate({
      arbiter: createWriteArbiter('host'),
      access: 'spectate',
      passphrase: 'sekret',
    });
    expect(gate.hasPassphrase).toBe(true);
    expect(gate.admit({ id: 'v', name: 'v' }, 'wrong')).toBe(false);
    expect(gate.has('v')).toBe(false);
    expect(gate.admit({ id: 'v', name: 'v' }, 'sekret')).toBe(true);
    expect(gate.has('v')).toBe(true);
  });

  it('releases the token (via the arbiter) when a driving viewer is removed', () => {
    const arbiter = createWriteArbiter('host');
    const gate = createAccessGate({ arbiter, access: 'invite' });
    gate.admit({ id: 'ada', name: 'ada' });
    gate.promote('ada');
    arbiter.release('host'); // idle
    gate.requestControl('ada'); // ada now driving
    expect(arbiter.isDriver('ada')).toBe(true);

    gate.remove('ada'); // disconnect → arbiter.leave hands off
    expect(arbiter.isDriver('ada')).toBe(false);
    expect(gate.has('ada')).toBe(false);
  });
});
