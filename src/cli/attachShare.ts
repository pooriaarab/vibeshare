import { CaptureError } from '@pooriaarab/vibe-core/capture';
import { AttachError, createProcessTmuxClient, createTmuxCaptureSource, pickAttachTarget } from '../attach.js';
import type { TmuxClient } from '../attach.js';
import type { AttachCliOptions } from './parse.js';
import { mintShareRuntime } from './runtime.js';
import type { IO } from './runtimeTypes.js';
import { setShutdownRef } from './shutdown.js';

async function resolveTarget(
  options: AttachCliOptions,
  tmux: TmuxClient,
  io: IO,
): Promise<{ ok: true; target: string } | { ok: false; code: number }> {
  try {
    const target = await pickAttachTarget(options.target, tmux);
    // Fail closed on bad target BEFORE minting a share URL.
    await tmux.paneSize(target);
    return { ok: true, target };
  } catch (err) {
    const msg = err instanceof AttachError || err instanceof CaptureError || err instanceof Error ? err.message : String(err);
    const out = msg.startsWith('vibeshare') ? msg : `vibeshare attach: ${msg}`;
    io.err(out);
    return { ok: false, code: 2 };
  }
}

interface AttachRuntime {
  readonly created: { feed: { publishRaw: (d: string) => void; publishResize: (c: number, r: number) => void } };
  setInputSink: (s: (d: string) => void | null) => void;
}

function waitForAttachExit(): Promise<number> {
  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      resolve(code);
    };
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));
    setShutdownRef(shutdown);
  });
}

interface StartCaptureOpts {
  readonly target: string;
  readonly options: AttachCliOptions;
  readonly tmux: TmuxClient;
  readonly runtime: AttachRuntime;
  readonly io: IO;
}

async function startCapture(
  opts: StartCaptureOpts,
): Promise<{ ok: true; stop: () => Promise<void> } | { ok: false; code: number }> {
  const { target, options, tmux, runtime, io } = opts;
  try {
    const source = createTmuxCaptureSource({
      target,
      tmux,
      ...(options.sizePollMs !== undefined ? { sizePollMs: options.sizePollMs } : {}),
    });
    const handle = await source.start(runtime.created.feed);
    if (handle.writeInput) {
      runtime.setInputSink((data) => { void handle.writeInput?.(data); });
    }
    return { ok: true, stop: () => handle.stop() };
  } catch (err) {
    const msg = err instanceof AttachError || err instanceof Error ? err.message : String(err);
    const out = msg.startsWith('vibeshare') ? msg : `vibeshare attach: ${msg}`;
    io.err(out);
    return { ok: false, code: 2 };
  }
}

export async function attachShare(options: AttachCliOptions, io: IO): Promise<number> {
  // One client for target validation AND the live capture, as before: a second
  // createProcessTmuxClient() would be a separate process wrapper.
  const tmux = options.tmux ?? createProcessTmuxClient();
  const resolved = await resolveTarget(options, tmux, io);
  if (!resolved.ok) return resolved.code;
  const target = resolved.target;
  const sessionLabel = options.name ?? `tmux ${target}`;
  const minted = await mintShareRuntime(options, io, sessionLabel);
  if (!minted.ok) return minted.code;
  const { runtime } = minted;
  const suffix = options.access === 'invite' ? ' (attach · viewers may request to drive)' : ' (attach · read-only)';
  io.out(`  source:   tmux ${target}${suffix}`);
  const cap = await startCapture({ target, options, tmux, runtime, io });
  if (!cap.ok) {
    await runtime.cleanup();
    return cap.code;
  }
  const exitCode = await waitForAttachExit();
  try { await cap.stop(); } catch { /* best effort */ }
  await runtime.cleanup();
  return exitCode;
}
