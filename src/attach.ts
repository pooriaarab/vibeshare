/**
 * Tmux attach POLICY for `vibeshare attach [target]`.
 *
 * Target parsing, pane listing/picker, multiplexer detection, and the
 * feed-facing capture adapter live here. The capture MECHANISM (pipe-pane
 * fifo, capture-pane backlog, size poll, send-keys) comes from
 * `@pooriaarab/vibe-core/capture` (`tmuxCapture` / `createProcessTmuxRunner`).
 *
 * Collaborator input (when the host approves a viewer on an `--invite`
 * share) is applied via `tmux send-keys -l`. Spectate shares never reach
 * that path — the write gate lives in ViewerRegistry.canWrite(), not here.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  CaptureError,
  createProcessTmuxRunner,
  tmuxCapture,
  type TmuxRunner,
} from '@pooriaarab/vibe-core/capture';
import type { CaptureFeed, CaptureHandle, CaptureSource } from './capture.js';

// ---------------------------------------------------------------- errors

/** Policy/setup failure for attach (bad target, no tmux, screen, …). */
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
export type { TmuxPipe } from '@pooriaarab/vibe-core/capture';

/**
 * Tmux seam used by attach POLICY (listing/picker) and by the capture
 * adapter. Extends vibe-core's {@link TmuxRunner} with `listPanes`.
 */
export interface TmuxClient extends TmuxRunner {
  /** List all panes (tmux list-panes -a). */
  listPanes(): Promise<TmuxPane[]>;
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

// ---------------------------------------------------------------- real tmux client (policy list + vibe-core runner)

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

/**
 * Production TmuxClient: capture MECHANISM from vibe-core's process runner,
 * plus local `listPanes` for the attach picker.
 */
export function createProcessTmuxClient(opts: { tmpDir?: string } = {}): TmuxClient {
  const runner = createProcessTmuxRunner(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {});
  return {
    available: () => runner.available(),
    paneSize: (target) => runner.paneSize(target),
    capturePane: (target) => runner.capturePane(target),
    openPipe: (target) => runner.openPipe(target),
    sendKeys: (target, data) => runner.sendKeys(target, data),
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
  };
}

// ---------------------------------------------------------------- capture source (adapter over vibe-core tmuxCapture)

/** Map a vibeshare TmuxClient onto vibe-core's TmuxRunner (drop listPanes). */
function asRunner(tmux: TmuxClient): TmuxRunner {
  return {
    available: () => tmux.available(),
    paneSize: (target) => tmux.paneSize(target),
    capturePane: (target) => tmux.capturePane(target),
    openPipe: (target) => tmux.openPipe(target),
    sendKeys: (target, data) => tmux.sendKeys(target, data),
  };
}

/**
 * Build a feed-facing CaptureSource that taps a tmux pane via vibe-core
 * `tmuxCapture`. Presents the vibeshare CaptureHandle shape (label +
 * writeInput + stop) expected by the CLI and tests.
 */
export function createTmuxCaptureSource(opts: AttachOptions): CaptureSource {
  const tmux =
    opts.tmux ??
    createProcessTmuxClient(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {});
  const target = opts.target;

  return {
    async start(feed: CaptureFeed): Promise<CaptureHandle> {
      const source = tmuxCapture(target, {
        runner: asRunner(tmux),
        ...(opts.sizePollMs !== undefined ? { sizePollMs: opts.sizePollMs } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
      });

      try {
        await source.start(
          (data) => {
            try {
              feed.publishRaw(data);
            } catch {
              // feed closed mid-stream
            }
          },
          (cols, rows) => {
            try {
              feed.publishResize(cols, rows);
            } catch {
              // feed closed mid-stream
            }
          },
        );
      } catch (err) {
        // Surface vibe-core CaptureError as AttachError so CLI messaging stays stable.
        if (err instanceof CaptureError || (err instanceof Error && err.name === 'CaptureError')) {
          const msg = err.message;
          if (/tmux is not installed/i.test(msg)) {
            throw new AttachError(
              'tmux is not installed (or not on PATH).\n' +
                '  `vibeshare attach` shares an already-running tmux pane.\n' +
                '  Install tmux, or launch a new session wrapped instead:\n' +
                '    vibeshare -- <cmd>',
            );
          }
          throw new AttachError(msg);
        }
        throw err;
      }

      let stopped = false;
      return {
        label: `tmux:${target}`,
        writeInput: async (data: string) => {
          if (stopped || data.length === 0) return;
          await source.write(data);
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await source.stop();
        },
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
