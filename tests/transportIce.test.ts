import { describe, expect, it } from 'vitest';
import {
  embedTurnCredentials,
  iceServersForWire,
  serverStringForWire,
  toNodeIceServers,
} from '../src/webrtc/transportIce.js';

describe('serverStringForWire', () => {
  it('splits embedded user:pass out of a TURN URL', () => {
    expect(serverStringForWire('turn:u:p@turn.invalid:3478')).toEqual({
      urls: 'turn:turn.invalid:3478',
      username: 'u',
      credential: 'p',
    });
  });

  it('splits a username-only TURN URL, leaving no userinfo in urls', () => {
    // embedTurnCredentials emits this form whenever there is no credential.
    // Browsers reject an RTCIceServer whose `urls` still carries userinfo, so
    // the username has to move into its own field here too.
    expect(serverStringForWire('turn:u@turn.invalid:3478')).toEqual({
      urls: 'turn:turn.invalid:3478',
      username: 'u',
    });
  });

  it('keeps the scheme and slashes, and drops an empty credential', () => {
    expect(serverStringForWire('turns://u@turn.invalid:5349')).toEqual({
      urls: 'turns://turn.invalid:5349',
      username: 'u',
    });
    expect(serverStringForWire('turn:u:@turn.invalid:3478')).toEqual({
      urls: 'turn:turn.invalid:3478',
      username: 'u',
    });
  });

  it('passes through URLs that carry no credentials', () => {
    for (const url of [
      'stun:stun.l.google.com:19302',
      'turn:turn.invalid:3478',
      'turn:turn.invalid:3478?transport=tcp',
      'stun:u@stun.invalid', // not a TURN scheme — left alone
      'turn:@turn.invalid', // no username to lift out
    ]) {
      expect(serverStringForWire(url)).toEqual({ urls: url });
    }
  });
});

describe('embedTurnCredentials / serverStringForWire round trip', () => {
  const CASES: ReadonlyArray<{ url: string; username?: string; credential?: string }> = [
    { url: 'turn:turn.invalid:3478', username: 'u', credential: 'p' },
    { url: 'turn:turn.invalid:3478', username: 'u' },
    { url: 'turns://turn.invalid:5349', username: 'u' },
    { url: 'turn:turn.invalid:3478?transport=tcp', username: 'user-name_1' },
    { url: 'stun:stun.invalid:19302' },
  ];

  it('recovers the original server through the node string form', () => {
    for (const c of CASES) {
      const wire = embedTurnCredentials(c.url, c.username, c.credential);
      const back = serverStringForWire(wire);
      const expected: Record<string, string> = { urls: c.url };
      // A non-TURN URL never picks up credentials in the first place.
      if (c.username !== undefined && c.url.startsWith('turn')) expected['username'] = c.username;
      if (c.credential !== undefined) expected['credential'] = c.credential;
      expect(back).toEqual(expected);
    }
  });

  it('never leaves userinfo inside urls', () => {
    for (const c of CASES) {
      const back = serverStringForWire(embedTurnCredentials(c.url, c.username, c.credential));
      const urls = typeof back.urls === 'string' ? [back.urls] : back.urls;
      for (const u of urls) expect(u).not.toContain('@');
    }
  });
});

describe('iceServersForWire', () => {
  it('maps strings and passes objects through untouched', () => {
    const obj = { urls: 'turn:turn.invalid:3478', username: 'u', credential: 'p' };
    expect(iceServersForWire(['stun:stun.invalid:19302', 'turn:u@turn.invalid:3478', obj])).toEqual([
      { urls: 'stun:stun.invalid:19302' },
      { urls: 'turn:turn.invalid:3478', username: 'u' },
      obj,
    ]);
  });
});

describe('toNodeIceServers', () => {
  it('embeds a username with no credential as user@host', () => {
    expect(toNodeIceServers([{ urls: 'turn:turn.invalid:3478', username: 'u' }])).toEqual([
      'turn:u@turn.invalid:3478',
    ]);
  });
});
