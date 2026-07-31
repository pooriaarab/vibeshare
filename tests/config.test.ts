import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNALING_URL,
  readConfigFile,
  resolveSignalingUrl,
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

  it('passes the slice-3 tunnel placeholder through verbatim', () => {
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
