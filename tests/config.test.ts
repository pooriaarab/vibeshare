import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ICE_SERVERS,
  DEFAULT_SIGNALING_URL,
  parseIceServersJson,
  readConfigFile,
  resolveIceServers,
  resolveSignalingUrl,
  resolveTunnelConfig,
} from '../src/config.js';
import { tempHome } from './helpers.js';

describe('resolveSignalingUrl', () => {
  it('defaults to the getvibe.dev worker', () => {
    expect(resolveSignalingUrl({})).toBe(DEFAULT_SIGNALING_URL);
    expect(DEFAULT_SIGNALING_URL).toBe('wss://getvibe.dev/vibeshare');
  });

  it('precedence: flag > env > config file > default', () => {
    const file = { signalingUrl: 'wss://file.example/vibeshare' };
    expect(resolveSignalingUrl({ file })).toBe('wss://file.example/vibeshare');
    expect(resolveSignalingUrl({ file, env: 'wss://env.example/vibeshare' })).toBe('wss://env.example/vibeshare');
    expect(
      resolveSignalingUrl({ file, env: 'wss://env.example/vibeshare', flag: 'ws://localhost:8787/vibeshare' }),
    ).toBe('ws://localhost:8787/vibeshare');
  });

  it('treats blank values as unset (empty env cannot shadow the file)', () => {
    const file = { signalingUrl: 'wss://file.example/vibeshare' };
    expect(resolveSignalingUrl({ env: '', file })).toBe('wss://file.example/vibeshare');
    expect(resolveSignalingUrl({ flag: '   ', env: 'wss://env.example/vibeshare', file })).toBe(
      'wss://env.example/vibeshare',
    );
    expect(resolveSignalingUrl({ flag: '', env: '  ', file: {} })).toBe(DEFAULT_SIGNALING_URL);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveSignalingUrl({ flag: '  ws://localhost:8787/vibeshare  ' })).toBe(
      'ws://localhost:8787/vibeshare',
    );
  });
});

describe('readConfigFile', () => {
  let home: ReturnType<typeof tempHome> | undefined;
  afterEach(() => {
    home?.cleanup();
    home = undefined;
  });

  const write = (contents: string): string => {
    home = tempHome();
    const file = join(home.dir, 'config.json');
    writeFileSync(file, contents);
    return file;
  };

  it('returns {} when the file is missing', () => {
    home = tempHome();
    expect(readConfigFile(join(home.dir, 'config.json'))).toEqual({});
  });

  it('parses a valid config', () => {
    const file = write(JSON.stringify({ signalingUrl: 'wss://mine.example/vibeshare' }));
    expect(readConfigFile(file)).toEqual({ signalingUrl: 'wss://mine.example/vibeshare' });
  });

  it('parses the tunnel config shape (provider + account)', () => {
    const tunnel = { provider: 'ngrok', account: { ngrok: { authtoken: 'secret' } } };
    const file = write(JSON.stringify({ signalingUrl: 'wss://mine.example/vibeshare', tunnel }));
    expect(readConfigFile(file)).toEqual({ signalingUrl: 'wss://mine.example/vibeshare', tunnel });
  });

  it('never throws on invalid JSON or wrong shapes', () => {
    expect(readConfigFile(write('not json at all'))).toEqual({});
    expect(readConfigFile(write('[1,2,3]'))).toEqual({});
    expect(readConfigFile(write('null'))).toEqual({});
    expect(readConfigFile(write('{"signalingUrl": 42}'))).toEqual({});
    expect(readConfigFile(write('{"signalingUrl": ""}'))).toEqual({});
  });

  it('ignores unknown fields', () => {
    const file = write(JSON.stringify({ signalingUrl: 'wss://mine.example/vibeshare', future: true }));
    expect(readConfigFile(file)).toEqual({ signalingUrl: 'wss://mine.example/vibeshare' });
  });
});

describe('resolveTunnelConfig', () => {
  it('cascade when flag is true / empty (no preferred provider)', () => {
    expect(resolveTunnelConfig({ flag: true }).provider).toBeUndefined();
    expect(resolveTunnelConfig({ flag: '' }).provider).toBeUndefined();
    expect(resolveTunnelConfig({}).provider).toBeUndefined();
  });

  it('precedence: flag > env > file > cascade', () => {
    const file = { tunnel: { provider: 'file-prov' } };
    expect(resolveTunnelConfig({ file }).provider).toBe('file-prov');
    expect(resolveTunnelConfig({ file, env: 'env-prov' }).provider).toBe('env-prov');
    expect(resolveTunnelConfig({ file, env: 'env-prov', flag: 'flag-prov' }).provider).toBe('flag-prov');
    // explicit cascade flag wins over env/file (user said --tunnel with no name)
    expect(resolveTunnelConfig({ file, env: 'env-prov', flag: true }).provider).toBeUndefined();
  });

  it('maps ngrok authtoken from env and file into startOpts.env', () => {
    const fromEnv = resolveTunnelConfig({
      flag: 'ngrok',
      processEnv: { NGROK_AUTHTOKEN: 'env-secret' },
    });
    expect(fromEnv.startOpts.env?.['NGROK_AUTHTOKEN']).toBe('env-secret');

    const fromFile = resolveTunnelConfig({
      flag: 'ngrok',
      file: { tunnel: { account: { ngrok: { authtoken: 'file-secret' } } } },
      processEnv: {},
    });
    expect(fromFile.startOpts.env?.['NGROK_AUTHTOKEN']).toBe('file-secret');

    // env wins over file
    const both = resolveTunnelConfig({
      flag: 'ngrok',
      file: { tunnel: { account: { ngrok: { token: 'file-secret' } } } },
      processEnv: { NGROK_AUTHTOKEN: 'env-secret' },
    });
    expect(both.startOpts.env?.['NGROK_AUTHTOKEN']).toBe('env-secret');
  });

  it('resolves frp serverAddr from env / endpoint / account', () => {
    expect(
      resolveTunnelConfig({
        flag: 'frp',
        processEnv: { FRP_SERVER_ADDR: 'env.example:7000' },
      }).startOpts.serverAddr,
    ).toBe('env.example:7000');

    expect(
      resolveTunnelConfig({
        flag: 'frp',
        file: { tunnel: { endpoint: 'file.example:7000' } },
        processEnv: {},
      }).startOpts.serverAddr,
    ).toBe('file.example:7000');

    expect(
      resolveTunnelConfig({
        flag: 'frp',
        file: { tunnel: { account: { frp: { serverAddr: 'acct.example:7000' } } } },
        processEnv: {},
      }).startOpts.serverAddr,
    ).toBe('acct.example:7000');
  });

  it('resolves hostname from file / cloudflared account', () => {
    expect(
      resolveTunnelConfig({
        flag: 'cloudflared',
        file: { tunnel: { hostname: 'share.example.com' } },
        processEnv: {},
      }).startOpts.hostname,
    ).toBe('share.example.com');
  });
});

describe('parseIceServersJson', () => {
  it('parses a JSON array of RTCIceServer objects (TURN creds included)', () => {
    const json = JSON.stringify([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:turn.example.com:3478', 'turn:turn.example.com:3478?transport=tcp'], username: 'u', credential: 'p' },
    ]);
    expect(parseIceServersJson(json)).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:turn.example.com:3478', 'turn:turn.example.com:3478?transport=tcp'], username: 'u', credential: 'p' },
    ]);
  });

  it('returns null on malformed JSON, non-arrays, and lists with no valid entry', () => {
    expect(parseIceServersJson('not json')).toBeNull();
    expect(parseIceServersJson('{"urls":"stun:x"}')).toBeNull();
    expect(parseIceServersJson('[]')).toBeNull();
    expect(parseIceServersJson('[{"nourls":true}, 42, null]')).toBeNull();
  });

  it('drops invalid entries but keeps valid ones', () => {
    expect(parseIceServersJson('[{"nourls":1}, {"urls":"stun:stun.example.com:19302"}]')).toEqual([
      { urls: 'stun:stun.example.com:19302' },
    ]);
  });
});

describe('resolveIceServers', () => {
  const turn = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }];
  const turnJson = JSON.stringify(turn);

  it('defaults to STUN-only when nothing is configured (unchanged behaviour)', () => {
    expect(resolveIceServers({})).toBe(DEFAULT_ICE_SERVERS);
    expect(resolveIceServers({})).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('precedence: --ice-servers flag > VIBESHARE_ICE_SERVERS env > config file > default', () => {
    const file = { iceServers: [{ urls: 'stun:file.example.com:19302' }] };
    const envJson = JSON.stringify([{ urls: 'stun:env.example.com:19302' }]);
    expect(resolveIceServers({ file })).toEqual([{ urls: 'stun:file.example.com:19302' }]);
    expect(resolveIceServers({ file, env: envJson })).toEqual([{ urls: 'stun:env.example.com:19302' }]);
    expect(resolveIceServers({ file, env: envJson, flag: turnJson })).toEqual(turn);
  });

  it('treats blank flag/env values as unset', () => {
    const file = { iceServers: [{ urls: 'stun:file.example.com:19302' }] };
    expect(resolveIceServers({ flag: '  ', env: '', file })).toEqual([{ urls: 'stun:file.example.com:19302' }]);
    expect(resolveIceServers({ flag: '', env: ' ', file: {} })).toBe(DEFAULT_ICE_SERVERS);
  });

  it('malformed flag JSON → clear error via onError, falls through to env/file/default', () => {
    const errors: string[] = [];
    const onError = (m: string): void => {
      errors.push(m);
    };
    const file = { iceServers: turn };
    // Malformed flag falls through to the config file…
    expect(resolveIceServers({ flag: '{oops', file, onError })).toEqual(turn);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--ice-servers');
    // …and a malformed flag + no other source lands on the STUN default.
    expect(resolveIceServers({ flag: '[{"broken":true}]', onError })).toBe(DEFAULT_ICE_SERVERS);
    expect(errors).toHaveLength(2);
    // Malformed env behaves the same way.
    expect(resolveIceServers({ env: 'nope', onError })).toBe(DEFAULT_ICE_SERVERS);
    expect(errors).toHaveLength(3);
    expect(errors[2]).toContain('VIBESHARE_ICE_SERVERS');
  });

  it('an empty array from flag/env/file is treated as unset (falls back)', () => {
    expect(resolveIceServers({ flag: '[]' })).toBe(DEFAULT_ICE_SERVERS);
    expect(resolveIceServers({ env: '[]' })).toBe(DEFAULT_ICE_SERVERS);
    expect(resolveIceServers({ file: { iceServers: [] } })).toBe(DEFAULT_ICE_SERVERS);
  });
});

describe('readConfigFile iceServers', () => {
  let home: ReturnType<typeof tempHome> | undefined;
  afterEach(() => {
    home?.cleanup();
    home = undefined;
  });

  const write = (contents: string): string => {
    home = tempHome();
    const file = join(home.dir, 'config.json');
    writeFileSync(file, contents);
    return file;
  };

  it('parses a valid iceServers key (TURN example)', () => {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com:3478', username: 'vibeshare', credential: 'secret' },
    ];
    const file = write(JSON.stringify({ iceServers }));
    expect(readConfigFile(file)).toEqual({ iceServers });
  });

  it('drops malformed entries; a fully-invalid key is treated as unset', () => {
    const mixed = write(
      JSON.stringify({ iceServers: [{ urls: '' }, { urls: ['stun:a.example.com:19302', ''] }, 'junk'] }),
    );
    expect(readConfigFile(mixed)).toEqual({ iceServers: [{ urls: ['stun:a.example.com:19302'] }] });

    expect(readConfigFile(write('{"iceServers": "stun:not-an-array"}'))).toEqual({});
    expect(readConfigFile(write('{"iceServers": []}'))).toEqual({});
    expect(readConfigFile(write('{"iceServers": [{"urls": 42}]}'))).toEqual({});
  });
});
