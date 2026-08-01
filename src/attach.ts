/**
 * Tmux capture source for `vibeshare attach [target]`.
 *
 * Shares an ALREADY-RUNNING terminal session by tapping a tmux pane:
 *   1. `tmux display -p`         → pane size → feed.publishResize
 *   2. `tmux capture-pane -pe`   → current screen → feed.publishRaw (backlog)
 *   3. `tmux pipe-pane -o`       → live raw bytes → feed.publishRaw
 *
 * Capture is always on; collaborator input (when the host approves a viewer
 * on an `--invite` share) is applied via `tmux send-keys -l` through
 * {@link TmuxClient.sendKeys}. Spectate shares never reach that path — the
 * write gate lives in ViewerRegistry.canWrite(), not here.
 *
 * All tmux IO goes through {@link TmuxClient} so tests can mock without a
 * real tmux binary. Production uses fifo + `pipe-pane`; mocks return an
 * in-memory Readable.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, unlinkSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import type { CaptureFeed, CaptureHandle, CaptureSource } from './capture.js';

// ---------------------------------------------------------------- errors

export class AttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachError';
  }
}

// ---------------------------------------------------------------- types

export interface TmuxPane {
  /** e.g. `mysess:1.0` */
  readonly target: string;
  readonly session: string;
  readonly window: number;
  readonly pane: number;
  readonly command: string;
  readonly width: number;
  readonly height: number;
}

/** Live byte stream from a pane; call stop() to end pipe-pane + release resources. */
export interface TmuxPipe {
  readonly stream: Readable;
  stop(): Promise<void>;
}

export interface TmuxClient {
  /** True if a `tmux` binary is on PATH. */
  available(): Promise<boolean>;
  /** List all panes (tmux list-panes -a). */
  listPanes(): Promise<TmuxPane[]>;
  /** Pane geometry; throws AttachError if target missing/invalid. */
  paneSize(target: string): Promise<{ cols: number; rows: number }>;
  /**
   * Current screen + scrollback with ANSI (`capture-pane -pe`).
   * Throws AttachError if target invalid.
   */
  capturePane(target: string): Promise<string>;
  /**
   * Start live capture of pane output.
   * Production: `tmux pipe-pane -o -t <target> 'cat >> fifo'` + Readable on fifo.
   * Tests: return an in-memory Readable the mock can push into.
   */
  openPipe(target: string): Promise<TmuxPipe>;
  /**
   * Type literal keys into the pane (`tmux send-keys -t <target> -l <data>`).
   * Used for approved collaborator input on attach shares. Empty data is a no-op.
   */
  sendKeys(target: string, data: string): Promise<void>;
}

export interface AttachOptions {
  /** tmux target (`session:window.pane`, `%pane_id`, …). */
  readonly target: string;
  /** Injectable tmux seam (tests). Default: real process-spawn client. */
  readonly tmux?: TmuxClient;
  /**
   * How often to re-check pane size for resize events (ms).
   * `0` disables polling. Default 1000.
   */
  readonly sizePollMs?: number;
  /** Override temp dir for the fifo (production client only; tests ignore). */
  readonly tmpDir?: string;
}

// ---------------------------------------------------------------- parsing / listing

const PANE_FORMAT =
  '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{session_name}\t#{window_index}\t#{pane_index}';

/** Parse one `list-panes -F` line produced with {@link PANE_FORMAT}. */
export function parsePaneLine(line: string): TmuxPane | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 7) return null;
  const [target, command, w, h, session, win, pane] = parts;
  if (!target || !session) return null;
  const width = Number(w);
  const height = Number(h);
  const window = Number(win);
  const paneIndex = Number(pane);
  if (![width, height, window, paneIndex].every((n) => Number.isFinite(n))) return null;
  return {
    target,
    session,
    window,
    pane: paneIndex,
    command: command || '?',
    width,
    height,
  };
}

/** Format panes for the interactive picker printed to the host. */
export function formatPaneList(panes: readonly TmuxPane[]): string {
  if (panes.length === 0) return '(no tmux panes)';
  const lines = panes.map((p) => `  ${p.target.padEnd(24)} ${p.command}  (${p.width}x${p.height})`);
  return lines.join('\n');
}

/**
 * Resolve which pane to attach.
 * - explicit target → use it (validated later by tmux)
 * - $TMUX_PANE set → that pane id
 * - else → undefined (caller should list + ask)
 */
export function resolveAttachTarget(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  const pane = env['TMUX_PANE'];
  if (typeof pane === 'string' && pane.trim() !== '') return pane.trim();
  return undefined;
}

/**
 * Detect a non-tmux multiplexer we refuse to half-support.
 * Returns a clear error message, or null if no blocker.
 */
export function detectUnsupportedMultiplexer(env: NodeJS.ProcessEnv = process.env): string | null {
  // STY is set inside GNU screen sessions.
  if (env['STY'] && !env['TMUX'] && !env['TMUX_PANE']) {
    return (
      'vibeshare attach: GNU screen is not supported yet.\n' +
      '  attach currently works with tmux only.\n' +
      '  Workarounds: run the session inside tmux, or launch wrapped:\n' +
      '    vibeshare -- <cmd>'
    );
  }
  return null;
}

// ---------------------------------------------------------------- real tmux client

async function runTmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        resolve({ code: 127, stdout: '', stderr: 'tmux: command not found' });
        return;
      }
      reject(e);
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function makeFifo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [path], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        void open(path, 'w')
          .then((f) => f.close())
          .then(() => resolve(), reject);
        return;
      }
      reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AttachError(`mkfifo failed for ${path} (exit ${code})`));
    });
  });
}

/**
 * Production TmuxClient that shells out to the `tmux` binary.
 * Live bytes: mkfifo + `tmux pipe-pane -o -t <target> "cat >> fifo"`.
 */
export function createProcessTmuxClient(opts: { tmpDir?: string } = {}): TmuxClient {
  return {
    async available() {
      const r = await runTmux(['-V']);
      return r.code === 0;
    },
    async listPanes() {
      const r = await runTmux(['list-panes', '-a', '-F', PANE_FORMAT]);
      if (r.code !== 0) {
        if (/no server running|error connecting|no sessions/i.test(r.stderr + r.stdout)) {
          return [];
        }
        throw new AttachError(
          `tmux list-panes failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
        );
      }
      return r.stdout
        .split('\n')
        .map(parsePaneLine)
        .filter((p): p is TmuxPane => p !== null);
    },
    async paneSize(target: string) {
      const r = await runTmux(['display', '-p', '-t', target, '#{pane_width} #{pane_height}']);
      if (r.code !== 0) {
        throw new AttachError(
          `tmux target not found: ${target}\n` +
            `  ${r.stderr.trim() || 'display-message failed'}\n` +
            `  List panes with: tmux list-panes -a`,
        );
      }
      const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) throw new AttachError(`could not parse pane size for ${target}: ${r.stdout.trim()}`);
      return { cols: Number(m[1]), rows: Number(m[2]) };
    },
    async capturePane(target: string) {
      // -p print to stdout, -e preserve escape sequences (ANSI/colors/cursor).
      const r = await runTmux(['capture-pane', '-pe', '-t', target]);
      if (r.code !== 0) {
        throw new AttachError(
          `tmux capture-pane failed for ${target}: ${r.stderr.trim() || `exit ${r.code}`}`,
        );
      }
      return r.stdout;
    },
    async openPipe(target: string) {
      const base = opts.tmpDir ?? tmpdir();
      const dir = await mkdtemp(join(base, 'vibeshare-attach-'));
      const fifoPath = join(dir, 'pane.fifo');
      await makeFifo(fifoPath);

      // Open read end before pipe-pane so the writer never blocks forever.
      // O_RDWR on a fifo lets open() return without a peer writer (POSIX).
      const fh = await open(fifoPath, 'r+');
      const stream = createReadStream('', { fd: fh.fd, autoClose: false });

      const dest = `cat >> ${shellSingleQuote(fifoPath)}`;
      // -o = stdout only.
      const r = await runTmux(['pipe-pane', '-o', '-t', target, dest]);
      if (r.code !== 0) {
        stream.destroy();
        await fh.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new AttachError(
          `tmux pipe-pane failed for ${target}: ${r.stderr.trim() || `exit ${r.code}`}`,
        );
      }

      let stopped = false;
      return {
        stream,
        async stop() {
          if (stopped) return;
          stopped = true;
          // No command arg = stop piping.
          await runTmux(['pipe-pane', '-t', target]);
          stream.destroy();
          try {
            await fh.close();
          } catch {
            /* already closed */
          }
          try {
            if (existsSync(fifoPath)) unlinkSync(fifoPath);
          } catch {
            /* ignore */
          }
          try {
            await rm(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };
    },
    async sendKeys(target: string, data: string) {
      if (data.length === 0) return;
      // -l = literal: every char is typed, not interpreted as a key name.
      // tmux caps a single argument; chunk large pastes.
      const CHUNK = 256;
      for (let i = 0; i < data.length; i += CHUNK) {
        const slice = data.slice(i, i + CHUNK);
        const r = await runTmux(['send-keys', '-t', target, '-l', '--', slice]);
        if (r.code !== 0) {
          throw new AttachError(
            `tmux send-keys failed for ${target}: ${r.stderr.trim() || `exit ${r.code}`}`,
          );
        }
      }
    },
  };
}

// ---------------------------------------------------------------- capture source

/**
 * Build a CaptureSource that taps a tmux pane into the raw-byte feed.
 *
 * Lifecycle:
 *   start → size → backlog(capture-pane) → openPipe live → handle
 *   stop  → pipe.stop()
 */
export function createTmuxCaptureSource(opts: AttachOptions): CaptureSource {
  const tmux =
    opts.tmux ??
    createProcessTmuxClient(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {});
  const sizePollMs = opts.sizePollMs ?? 1000;
  const target = opts.target;

  return {
    async start(feed: CaptureFeed): Promise<CaptureHandle> {
      if (!(await tmux.available())) {
        throw new AttachError(
          'tmux is not installed (or not on PATH).\n' +
            '  `vibeshare attach` shares an already-running tmux pane.\n' +
            '  Install tmux, or launch a new session wrapped instead:\n' +
            '    vibeshare -- <cmd>',
        );
      }

      // Validate target + initial size up front (fail closed).
      const size = await tmux.paneSize(target);
      feed.publishResize(size.cols, size.rows);

      // Backlog first so late-joining viewers reconstruct the current screen
      // before live bytes land.
      const screen = await tmux.capturePane(target);
      if (screen.length > 0) {
        feed.publishRaw(screen);
      }

      let pipe: TmuxPipe;
      try {
        pipe = await tmux.openPipe(target);
      } catch (err) {
        throw err;
      }

      let stopped = false;
      let lastCols = size.cols;
      let lastRows = size.rows;
      let pollTimer: NodeJS.Timeout | null = null;

      const onData = (chunk: string | Buffer): void => {
        if (stopped) return;
        try {
          feed.publishRaw(chunk);
        } catch {
          // feed closed mid-stream
        }
      };
      pipe.stream.on('data', onData);

      if (sizePollMs > 0) {
        pollTimer = setInterval(() => {
          void (async () => {
            if (stopped) return;
            try {
              const s = await tmux.paneSize(target);
              if (s.cols !== lastCols || s.rows !== lastRows) {
                lastCols = s.cols;
                lastRows = s.rows;
                feed.publishResize(s.cols, s.rows);
              }
            } catch {
              // pane gone — stop() will be driven by the share lifecycle
            }
          })();
        }, sizePollMs);
        pollTimer.unref?.();
      }

      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        pipe.stream.off('data', onData);
        try {
          await pipe.stop();
        } catch {
          /* best effort */
        }
      };

      return {
        label: `tmux:${target}`,
        /** Apply approved collaborator input to the live pane. */
        writeInput: async (data: string) => {
          if (stopped || data.length === 0) return;
          await tmux.sendKeys(target, data);
        },
        stop,
      };
    },
  };
}

// ---------------------------------------------------------------- target picker

/**
 * Interactive / CLI helper: pick a target when the user didn't pass one.
 * Uses $TMUX_PANE when set; otherwise lists panes and errors with the list
 * (non-TTY) or prompts (TTY).
 */
export async function pickAttachTarget(
  explicit: string | undefined,
  tmux: TmuxClient,
  opts: {
    env?: NodeJS.ProcessEnv;
    isTty?: boolean;
    stdin?: NodeJS.ReadableStream;
    stderr?: NodeJS.WritableStream;
  } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const unsupported = detectUnsupportedMultiplexer(env);
  if (unsupported) throw new AttachError(unsupported);

  if (!(await tmux.available())) {
    throw new AttachError(
      'tmux is not installed (or not on PATH).\n' +
        '  `vibeshare attach` shares an already-running tmux pane.\n' +
        '  Install tmux, or launch a new session wrapped instead:\n' +
        '    vibeshare -- <cmd>',
    );
  }

  const resolved = resolveAttachTarget(explicit, env);
  if (resolved !== undefined) return resolved;

  const panes = await tmux.listPanes();
  if (panes.length === 0) {
    throw new AttachError(
      'no tmux panes found.\n' +
        '  `vibeshare attach` needs an already-running tmux session.\n' +
        '  Start one (`tmux new -s demo`), or launch wrapped:\n' +
        '    vibeshare -- <cmd>',
    );
  }

  const list = formatPaneList(panes);
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);
  if (!isTty) {
    throw new AttachError(
      'attach needs a target pane (non-interactive).\n' +
        '  Usage: vibeshare attach <session:window.pane>\n' +
        '  Available panes:\n' +
        list,
    );
  }

  const input = opts.stdin ?? process.stdin;
  const output = opts.stderr ?? process.stderr;
  output.write(`tmux panes:\n${list}\n`);
  output.write('Pass one as: vibeshare attach <target>\n');
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('target> ')).trim();
    if (!answer) {
      throw new AttachError('no target selected');
    }
    return answer;
  } finally {
    rl.close();
  }
}
