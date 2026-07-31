import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError, parseArgv, run } from '../src/cli.js';
import { tempHome } from './helpers.js';

describe('parseArgv', () => {
  it('bare invocation starts a spectate share until stopped', () => {
    expect(parseArgv([])).toEqual({
      cmd: 'start',
      options: {
        access: 'spectate',
        expiry: 'stop',
        port: 0,
        host: '127.0.0.1',
        yes: false,
        public: false,
        command: [],
      },
    });
  });

  it('parses the full start option set', () => {
    const cmd = parseArgv([
      'start', '--invite', '--expire', '24h', '--pass', 'pw', '--port', '4000',
      '--host', '0.0.0.0', '--name', 'demo', '--yes',
    ]);
    expect(cmd).toEqual({
      cmd: 'start',
      options: {
        access: 'invite',
        expiry: '24h',
        passphrase: 'pw',
        port: 4000,
        host: '0.0.0.0',
        name: 'demo',
        yes: true,
        public: false,
        command: [],
      },
    });
  });

  it('parses --public and --signaling', () => {
    expect(parseArgv(['--public'])).toMatchObject({ cmd: 'start', options: { public: true } });
    const cmd = parseArgv(['--public', '--signaling', 'ws://localhost:8787/vibeshare']);
    expect(cmd).toMatchObject({
      cmd: 'start',
      options: { public: true, signaling: 'ws://localhost:8787/vibeshare' },
    });
    // --signaling without --public is accepted (it just has no effect locally)
    expect(parseArgv(['--signaling', 'wss://example.com/vibeshare'])).toMatchObject({
      options: { public: false, signaling: 'wss://example.com/vibeshare' },
    });
  });

  it('takes the shared command after --', () => {
    const cmd = parseArgv(['--invite', '--', 'npm', 'test', '--watch']);
    expect(cmd).toMatchObject({ cmd: 'start', options: { access: 'invite', command: ['npm', 'test', '--watch'] } });
  });

  it('takes bare words as the command too', () => {
    const cmd = parseArgv(['npm', 'run', 'dev']);
    expect(cmd).toMatchObject({ cmd: 'start', options: { command: ['npm', 'run', 'dev'] } });
  });

  it('-y is the short consent flag; --expiry is an alias', () => {
    expect(parseArgv(['-y', '--expiry', '1h'])).toMatchObject({ options: { yes: true, expiry: '1h' } });
  });

  it('routes subcommands', () => {
    expect(parseArgv(['stop'])).toEqual({ cmd: 'stop' });
    expect(parseArgv(['stop', 'abc123'])).toEqual({ cmd: 'stop', share: 'abc123' });
    expect(parseArgv(['viewers'])).toEqual({ cmd: 'viewers', json: false });
    expect(parseArgv(['viewers', '--json'])).toEqual({ cmd: 'viewers', json: true });
    expect(parseArgv(['viewers', '--approve', 'v1'])).toMatchObject({ cmd: 'viewers', approve: 'v1' });
    expect(parseArgv(['viewers', '--deny', 'v2'])).toMatchObject({ cmd: 'viewers', deny: 'v2' });
    expect(parseArgv(['viewers', '--kick', 'v3'])).toMatchObject({ cmd: 'viewers', kick: 'v3' });
    expect(parseArgv(['viewers', 'share-id', '--json'])).toMatchObject({ cmd: 'viewers', share: 'share-id', json: true });
    expect(parseArgv(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgv(['--version'])).toEqual({ cmd: 'version' });
  });

  it('rejects bad usage with CliUsageError', () => {
    const bad = [
      ['--nope'],
      ['--port', 'abc'],
      ['--port', '99999'],
      ['--expire'],
      ['--pass'],
      ['--signaling'],
      ['viewers', '--approve'],
      ['viewers', '--approve', 'a', '--kick', 'b'],
      ['viewers', '--bogus'],
      ['viewers', 'one', 'two'],
      ['stop', 'a', 'b'],
      ['stop', '--force'],
    ];
    for (const argv of bad) {
      expect(() => parseArgv(argv), argv.join(' ')).toThrow(CliUsageError);
    }
  });
});

describe('run (with an isolated VIBESHARE_HOME)', () => {
  let home: ReturnType<typeof tempHome>;
  afterEach(() => {
    home?.cleanup();
    delete process.env['VIBESHARE_HOME'];
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    };
  };

  it('prints version and help', async () => {
    const v = io();
    expect(await run(['--version'], v.io)).toBe(0);
    expect(v.out.join()).toMatch(/^vibeshare \d+\.\d+\.\d+$/);
    const h = io();
    expect(await run(['--help'], h.io)).toBe(0);
    expect(h.out.join()).toContain('vibeshare viewers');
  });

  it('usage errors exit 2 with help on stderr', async () => {
    const u = io();
    expect(await run(['--bogus'], u.io)).toBe(2);
    expect(u.err.join()).toContain('unknown option');
  });

  it('viewers without an active share exits 1', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    expect(await run(['viewers'], c.io)).toBe(1);
    expect(c.err.join()).toContain('no active vibeshare share');
  });

  it('full start path: consent, server, shared command, state file cleanup', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    // --yes grants consent non-interactively; `echo` exits right away, which
    // tears the share down like a finished session would.
    const code = await run(['--yes', '--', 'echo', 'hello-spectators'], c.io);
    expect(code).toBe(0);
    const printed = c.out.join('\n');
    expect(printed).toContain('no data out');
    expect(printed).toMatch(/url:\s+http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{12}/);
    expect(printed).toContain('access:   spectate');
    // Consent was recorded in the isolated home.
    const { readFileSync } = await import('node:fs');
    const consent = JSON.parse(readFileSync(`${home.dir}/consent.json`, 'utf8')) as Array<{ scope: string }>;
    expect(consent.some((g) => g.scope === 'share:session')).toBe(true);
    // State file cleaned up on exit (no records left under shares/).
    const { existsSync, readdirSync } = await import('node:fs');
    const sharesDir = `${home.dir}/shares`;
    expect(existsSync(sharesDir) ? readdirSync(sharesDir).length : 0).toBe(0);
  });

  it('stop without an active share exits 1', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    expect(await run(['stop'], c.io)).toBe(1);
  });
});
