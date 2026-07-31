import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNALING_URL,
  readConfigFile,
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
