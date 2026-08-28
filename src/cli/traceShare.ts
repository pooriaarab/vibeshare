import type { TraceCliOptions } from './parse.js';
import { mintShareRuntime } from './runtime.js';
import type { IO } from './runtimeTypes.js';
import { setShutdownRef } from './shutdown.js';
import { createTranscriptCaptureSource } from '../transcript/source.js';

async function ensureTraceConsent(io: IO, options: TraceCliOptions): Promise<boolean> {
  if (options.yes) return true;
  const warning =
    `⚠ Sharing your FULL ${options.agent} transcript for ${options.cwd} — every prompt, model reply,\n` +
    `  and tool output in this session becomes visible to anyone with the URL.\n` +
    `  Secrets are auto-redacted (best-effort, not guaranteed). Continue? [y/N]`;
  io.err(warning);
  if (!process.stdin.isTTY) {
    io.err('refusing to share transcript non-interactively — re-run with --yes');
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(' ');
    const { parseConfirm } = await import('@pooriaarab/vibe-core');
    if (!parseConfirm(answer)) {
      io.err('aborted — transcript was not shared');
      return false;
    }
    const { loadLedger } = await import('../consent.js');
    const { SHARE_SCOPE } = await import('../manager.js');
    loadLedger().grant(SHARE_SCOPE, 'granted via vibeshare trace prompt');
    return true;
  } finally {
    rl.close();
  }
}

function waitForTraceExit(): Promise<number> {
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

export async function traceShare(options: TraceCliOptions, io: IO): Promise<number> {
  if (!(await ensureTraceConsent(io, options))) return 1;
  const sessionLabel = options.name ?? `${options.agent} transcript`;
  const minted = await mintShareRuntime({ ...options, feedCapacity: 200_000 }, io, sessionLabel);
  if (!minted.ok) return minted.code;
  const { runtime } = minted;
  const { created } = runtime;
  const source = createTranscriptCaptureSource({ agent: options.agent, cwd: options.cwd });
  io.out(`  source:   ${options.agent} transcript · read-only`);
  let handle: Awaited<ReturnType<typeof source.start>> | null = null;
  try {
    handle = await source.start(created.feed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out = msg.startsWith('vibeshare') ? msg : `vibeshare trace: ${msg}`;
    io.err(out);
    await runtime.cleanup();
    return 2;
  }
  const exitCode = await waitForTraceExit();
  await handle.stop().catch(() => undefined);
  await runtime.cleanup();
  return exitCode;
}
