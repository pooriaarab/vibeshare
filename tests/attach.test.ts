/**
 * attach — capture-source unit tests.
 *
 * No real tmux: every test injects a mock TmuxClient. Covers target parsing /
 * listing, backlog-from-capture-pane, live pipe-pane bytes, resize, and
 * fail-closed errors when tmux/target is missing.
 */
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachError,
  createTmuxCaptureSource,
  detectUnsupportedMultiplexer,
  formatPaneList,
  parsePaneLine,
  pickAttachTarget,
  resolveAttachTarget,
  type TmuxClient,
  type TmuxPane,
  type TmuxPipe,
} from '../src/attach.js';
import type { CaptureFeed } from '../src/capture.js';
import { SessionFeed } from '@pooriaarab/vibe-core/feed';
import { parseArgv, runCommand } from '../src/cli.js';
import { tempHome } from './helpers.js';

// ---------------------------------------------------------------- pure helpers

describe('parsePaneLine / formatPaneList', () => {
  it('parses a list-panes -F line', () => {
    const line = 'demo:1.0\tclaude\t120\t40\tdemo\t1\t0';
    expect(parsePaneLine(line)).toEqual({
      target: 'demo:1.0',
      session: 'demo',
      window: 1,
      pane: 0,
      command: 'claude',
      width: 120,
      height: 40,
    });
  });

  it('returns null for garbage', () => {
    expect(parsePaneLine('')).toBeNull();
    expect(parsePaneLine('no-tabs-here')).toBeNull();
    expect(parsePaneLine('a\tb\tnotnum\t1\ts\t1\t0')).toBeNull();
  });

  it('formats a pane list for the picker', () => {
    const panes: TmuxPane[] = [
      { target: 'demo:1.0', session: 'demo', window: 1, pane: 0, command: 'claude', width: 80, height: 24 },
      { target: 'work:0.1', session: 'work', window: 0, pane: 1, command: 'vim', width: 100, height: 30 },
    ];
    const text = formatPaneList(panes);
    expect(text).toContain('demo:1.0');
    expect(text).toContain('claude');
    expect(text).toContain('work:0.1');
    expect(formatPaneList([])).toBe('(no tmux panes)');
  });
});

describe('resolveAttachTarget / detectUnsupportedMultiplexer', () => {
  it('prefers an explicit target', () => {
    expect(resolveAttachTarget('sess:0.0', { TMUX_PANE: '%9' })).toBe('sess:0.0');
  });

  it('falls back to $TMUX_PANE', () => {
    expect(resolveAttachTarget(undefined, { TMUX_PANE: '%3' })).toBe('%3');
    expect(resolveAttachTarget('  ', { TMUX_PANE: '%3' })).toBe('%3');
  });

  it('returns undefined when nothing is known', () => {
    expect(resolveAttachTarget(undefined, {})).toBeUndefined();
  });

  it('flags GNU screen (STY set, no TMUX)', () => {
    const msg = detectUnsupportedMultiplexer({ STY: '123.pts-0.hostname' });
    expect(msg).toMatch(/screen is not supported/i);
    expect(msg).toMatch(/vibeshare --/);
  });

  it('does not flag screen when already in tmux', () => {
    expect(detectUnsupportedMultiplexer({ STY: 'x', TMUX: '1' })).toBeNull();
    expect(detectUnsupportedMultiplexer({})).toBeNull();
  });
});

// ---------------------------------------------------------------- mock tmux

interface MockTmuxState {
  available: boolean;
  panes: TmuxPane[];
  sizes: Map<string, { cols: number; rows: number }>;
  screens: Map<string, string>;
  /** openPipe calls */
  opened: string[];
  stopped: string[];
  missing: Set<string>;
  /** Live writers keyed by target — tests push bytes after start. */
  live: Map<string, PassThrough>;
  /** sendKeys calls: { target, data } */
  sent: Array<{ target: string; data: string }>;
}

function createMockTmux(init: Partial<MockTmuxState> = {}): { client: TmuxClient; state: MockTmuxState } {
  const state: MockTmuxState = {
    available: init.available ?? true,
    panes: init.panes ?? [],
    sizes: init.sizes ?? new Map(),
    screens: init.screens ?? new Map(),
    opened: [],
    stopped: [],
    missing: init.missing ?? new Set(),
    live: new Map(),
    sent: [],
  };

  const client: TmuxClient = {
    async available() {
      return state.available;
    },
    async listPanes() {
      return state.panes;
    },
    async paneSize(target) {
      if (state.missing.has(target)) {
        throw new AttachError(
          `tmux target not found: ${target}\n  can't find pane\n  List panes with: tmux list-panes -a`,
        );
      }
      const s = state.sizes.get(target);
      if (!s) throw new AttachError(`tmux target not found: ${target}`);
      return s;
    },
    async capturePane(target) {
      if (state.missing.has(target)) {
        throw new AttachError(`tmux capture-pane failed for ${target}: can't find pane`);
      }
      return state.screens.get(target) ?? '';
    },
    async openPipe(target): Promise<TmuxPipe> {
      if (state.missing.has(target)) {
        throw new AttachError(`tmux pipe-pane failed for ${target}: can't find pane`);
      }
      state.opened.push(target);
      const stream = new PassThrough();
      state.live.set(target, stream);
      let stopped = false;
      return {
        stream,
        async stop() {
          if (stopped) return;
          stopped = true;
          state.stopped.push(target);
          state.live.delete(target);
          stream.end();
          stream.destroy();
        },
      };
    },
    async sendKeys(target, data) {
      if (state.missing.has(target)) {
        throw new AttachError(`tmux send-keys failed for ${target}: can't find pane`);
      }
      if (data.length === 0) return;
      state.sent.push({ target, data });
    },
  };

  return { client, state };
}

function collectFeed(): {
  feed: CaptureFeed;
  raw: string[];
  resizes: Array<{ cols: number; rows: number }>;
} {
  const raw: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const feed: CaptureFeed = {
    publishRaw(data) {
      raw.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    publishResize(cols, rows) {
      resizes.push({ cols, rows });
    },
  };
  return { feed, raw, resizes };
}

// ---------------------------------------------------------------- pickAttachTarget

describe('pickAttachTarget', () => {
  it('returns explicit target without listing', async () => {
    const { client, state } = createMockTmux({ available: true });
    const t = await pickAttachTarget('demo:1.0', client, { env: {}, isTty: false });
    expect(t).toBe('demo:1.0');
    expect(state.panes).toEqual([]);
  });

  it('uses $TMUX_PANE when no explicit target', async () => {
    const { client } = createMockTmux();
    const t = await pickAttachTarget(undefined, client, { env: { TMUX_PANE: '%7' }, isTty: false });
    expect(t).toBe('%7');
  });

  it('fails closed when tmux binary missing', async () => {
    const { client } = createMockTmux({ available: false });
    await expect(pickAttachTarget('x', client, { env: {}, isTty: false })).rejects.toThrow(
      /tmux is not installed/i,
    );
  });

  it('fails closed when no panes and no target', async () => {
    const { client } = createMockTmux({ panes: [] });
    await expect(pickAttachTarget(undefined, client, { env: {}, isTty: false })).rejects.toThrow(
      /no tmux panes/i,
    );
  });

  it('lists panes and errors in non-TTY when target omitted', async () => {
    const panes: TmuxPane[] = [
      { target: 'a:0.0', session: 'a', window: 0, pane: 0, command: 'zsh', width: 80, height: 24 },
    ];
    const { client } = createMockTmux({ panes });
    await expect(pickAttachTarget(undefined, client, { env: {}, isTty: false })).rejects.toThrow(
      /a:0\.0/,
    );
  });

  it('rejects GNU screen with a clear error', async () => {
    const { client } = createMockTmux();
    await expect(
      pickAttachTarget(undefined, client, { env: { STY: '1.pts' }, isTty: false }),
    ).rejects.toThrow(/screen is not supported/i);
  });
});

// ---------------------------------------------------------------- capture source

describe('createTmuxCaptureSource (mocked tmux)', () => {
  it('publishes resize + capture-pane backlog, then live pipe-pane bytes', async () => {
    const target = 'demo:1.0';
    const backlog = '\x1b[32mhello screen\x1b[0m\nline2';
    const { client, state } = createMockTmux({
      sizes: new Map([[target, { cols: 100, rows: 30 }]]),
      screens: new Map([[target, backlog]]),
    });
    const { feed, raw, resizes } = collectFeed();
    const source = createTmuxCaptureSource({
      target,
      tmux: client,
      sizePollMs: 0,
    });

    const handle = await source.start(feed);
    expect(handle.label).toBe(`tmux:${target}`);
    expect(resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(raw).toEqual([backlog]);
    expect(state.opened).toEqual([target]);

    // Live bytes via the mocked pipe stream.
    const live = state.live.get(target);
    expect(live).toBeDefined();
    live!.write('live-1');
    // PassThrough delivers synchronously to 'data' listeners.
    expect(raw.some((c) => c.includes('live-1'))).toBe(true);

    await handle.stop();
    expect(state.stopped).toContain(target);
    // stop is idempotent
    await handle.stop();
    expect(state.stopped.filter((t) => t === target)).toHaveLength(1);
  });

  it('uses a real SessionFeed so backlog lands as ordered raw entries', async () => {
    const target = '%1';
    const { client } = createMockTmux({
      sizes: new Map([[target, { cols: 80, rows: 24 }]]),
      screens: new Map([[target, 'BACKLOG-SCREEN']]),
    });
    const feed = new SessionFeed();
    const source = createTmuxCaptureSource({ target, tmux: client, sizePollMs: 0 });
    const handle = await source.start(feed);
    const backlog = feed.backlog();
    const types = backlog.map((e) => e.type);
    expect(types[0]).toBe('resize');
    expect(types).toContain('raw');
    const rawEntry = backlog.find((e) => e.type === 'raw');
    expect(
      rawEntry && rawEntry.type === 'raw'
        ? Buffer.from(rawEntry.data, 'base64').toString('utf8')
        : null,
    ).toBe('BACKLOG-SCREEN');
    await handle.stop();
    feed.close();
  });

  it('fails closed when tmux is unavailable', async () => {
    const { client } = createMockTmux({ available: false });
    const { feed } = collectFeed();
    const source = createTmuxCaptureSource({ target: 'x', tmux: client });
    await expect(source.start(feed)).rejects.toThrow(/tmux is not installed/i);
  });

  it('fails closed when target is invalid', async () => {
    const { client } = createMockTmux({
      missing: new Set(['nope:0.0']),
      sizes: new Map(),
    });
    const { feed } = collectFeed();
    const source = createTmuxCaptureSource({ target: 'nope:0.0', tmux: client });
    await expect(source.start(feed)).rejects.toThrow(/target not found/i);
  });

  it('writeInput routes approved collaborator keys through tmux send-keys -l', async () => {
    const target = 'demo:1.0';
    const { client, state } = createMockTmux({
      sizes: new Map([[target, { cols: 80, rows: 24 }]]),
      screens: new Map([[target, '']]),
    });
    const { feed } = collectFeed();
    const source = createTmuxCaptureSource({ target, tmux: client, sizePollMs: 0 });
    const handle = await source.start(feed);
    expect(typeof handle.writeInput).toBe('function');
    await handle.writeInput!('ls -la\r');
    await handle.writeInput!(''); // no-op
    expect(state.sent).toEqual([{ target, data: 'ls -la\r' }]);
    await handle.stop();
    // After stop, writeInput is a quiet no-op.
    await handle.writeInput!('nope');
    expect(state.sent).toHaveLength(1);
  });

  it('re-emits resize when pane size changes', async () => {
    const target = 's:0.0';
    const size = { cols: 80, rows: 24 };
    const { client, state } = createMockTmux({
      sizes: new Map([[target, { ...size }]]),
      screens: new Map([[target, '']]),
    });
    let calls = 0;
    const orig = client.paneSize.bind(client);
    client.paneSize = async (t) => {
      calls++;
      if (calls > 1) return { cols: 120, rows: 40 };
      return orig(t);
    };

    const { feed, resizes } = collectFeed();
    const source = createTmuxCaptureSource({
      target,
      tmux: client,
      sizePollMs: 30,
    });
    const handle = await source.start(feed);
    await new Promise((r) => setTimeout(r, 100));
    expect(resizes.length).toBeGreaterThanOrEqual(2);
    expect(resizes[resizes.length - 1]).toEqual({ cols: 120, rows: 40 });
    await handle.stop();
    expect(state.stopped).toContain(target);
  });
});

// ---------------------------------------------------------------- CLI parsing

describe('parseArgv — attach', () => {
  it('parses `attach` with optional target and share flags', () => {
    expect(parseArgv(['attach'])).toEqual({
      cmd: 'attach',
      options: {
        access: 'spectate',
        expiry: 'stop',
        port: 0,
        host: '127.0.0.1',
        yes: false,
        public: false,
        tunnel: false,
      },
    });
    expect(parseArgv(['attach', 'demo:1.0', '--public', '--yes', '--name', 'live'])).toEqual({
      cmd: 'attach',
      options: {
        access: 'spectate',
        expiry: 'stop',
        port: 0,
        host: '127.0.0.1',
        yes: true,
        public: true,
        tunnel: false,
        name: 'live',
        target: 'demo:1.0',
      },
    });
    expect(parseArgv(['attach', '--pass', 's3cret', '--expire', '1h', 'work:0.1'])).toMatchObject({
      cmd: 'attach',
      options: {
        passphrase: 's3cret',
        expiry: '1h',
        target: 'work:0.1',
      },
    });
  });

  it('rejects attach with -- <cmd> or extra positionals', () => {
    expect(() => parseArgv(['attach', '--', 'claude'])).toThrow(/does not take/);
    expect(() => parseArgv(['attach', 'a', 'b'])).toThrow(/at most one target/);
  });
});

// ---------------------------------------------------------------- CLI run with mock tmux

describe('runCommand attach (mocked tmux, no real binary)', () => {
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

  it('mints a local share from a mocked pane and tears down cleanly', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    const target = 'demo:0.0';
    const { client, state } = createMockTmux({
      sizes: new Map([[target, { cols: 80, rows: 24 }]]),
      screens: new Map([[target, 'initial\n']]),
    });

    const cmd = parseArgv(['attach', target, '--yes', '--name', 'attached-demo']);
    expect(cmd.cmd).toBe('attach');
    if (cmd.cmd !== 'attach') throw new Error('expected attach');
    cmd.options.tmux = client;
    cmd.options.sizePollMs = 0;

    const runPromise = runCommand(cmd, c.io);
    await vi.waitFor(
      () => {
        expect(c.out.join('\n')).toMatch(/url:\s+http:\/\/127\.0\.0\.1:/);
      },
      { timeout: 5000 },
    );
    expect(c.out.join('\n')).toContain('attached-demo');
    expect(c.out.join('\n')).toMatch(/source:\s+tmux demo:0\.0/);
    expect(state.opened).toEqual([target]);

    // Trigger shutdown the same way vibeshare stop / SIGTERM would.
    process.emit('SIGTERM', 'SIGTERM');
    const code = await runPromise;
    expect(code).toBe(143);
    expect(state.stopped).toContain(target);
  });

  it('prints a clear error when tmux is missing', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    const { client } = createMockTmux({ available: false });
    const cmd = parseArgv(['attach', 'x', '--yes']);
    if (cmd.cmd !== 'attach') throw new Error('expected attach');
    cmd.options.tmux = client;
    const code = await runCommand(cmd, c.io);
    expect(code).toBe(2);
    expect(c.err.join('\n')).toMatch(/tmux is not installed/i);
  });

  it('prints a clear error when the target pane is missing', async () => {
    home = tempHome();
    process.env['VIBESHARE_HOME'] = home.dir;
    const c = io();
    const { client } = createMockTmux({
      available: true,
      missing: new Set(['gone:0.0']),
    });
    const cmd = parseArgv(['attach', 'gone:0.0', '--yes']);
    if (cmd.cmd !== 'attach') throw new Error('expected attach');
    cmd.options.tmux = client;
    cmd.options.sizePollMs = 0;
    const code = await runCommand(cmd, c.io);
    expect(code).toBe(2);
    expect(c.err.join('\n')).toMatch(/target not found|capture-pane failed|not found/i);
  });
});
