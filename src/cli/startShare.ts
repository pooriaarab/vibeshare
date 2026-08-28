import * as pty from 'node-pty';
import { ptyCapture, type PtyProcess } from '@pooriaarab/vibe-core/capture';
import type { StartOptions } from './parse.js';
import { mintShareRuntime } from './runtime.js';
import type { IO } from './runtimeTypes.js';
import { setShutdownRef } from './shutdown.js';

function getCommandToRun(options: StartOptions): string[] {
  if (options.command.length > 0) return options.command;
  const shell = process.env['SHELL'];
  if (shell) return [shell];
  return ['/bin/sh'];
}

function getTermSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

type PtyHolder = { current: PtyProcess | null };
type ResolverHolder = { current: ((code: number) => void) | null };

function createPtySource(
  cmd: string[],
  size: { cols: number; rows: number },
  holder: PtyHolder,
  resolver: ResolverHolder,
) {
  const entry = cmd[0];
  if (!entry) throw new Error('missing command');
  return ptyCapture(entry, cmd.slice(1), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    spawner: {
      spawn(file, args, spawnOpts) {
        const p = pty.spawn(file, args as string[], spawnOpts);
        holder.current = p;
        p.onExit(({ exitCode: code, signal }) => {
          const fn = resolver.current;
          if (!fn) return;
          const exitCode = typeof code === 'number' ? code : (signal ? 128 : 0);
          fn(exitCode);
        });
        return p;
      },
    },
  });
}

async function startPtySource(
  source: ReturnType<typeof ptyCapture>,
  onData: (data: string) => void,
  onResize: (c: number, r: number) => void,
): Promise<void> {
  await source.start(onData, onResize);
}

function setupStdinBridge(source: ReturnType<typeof ptyCapture>): { stdin: NodeJS.ReadStream; wasRaw: boolean; onStdin: (chunk: Buffer | string) => void } {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
  if (stdin.isTTY) {
    try { stdin.setRawMode(true); } catch { /* ignore */ }
  }
  stdin.resume();
  const onStdin = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    void source.write(text);
  };
  stdin.on('data', onStdin);
  return { stdin, wasRaw, onStdin };
}

function setupWinch(
  holder: PtyHolder,
  feed: { publishResize(c: number, r: number): void },
): () => void {
  const onWinch = (): void => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 24;
    try { holder.current?.resize(c, r); } catch { /* closed */ }
    try { feed.publishResize(c, r); } catch { /* closed */ }
  };
  process.on('SIGWINCH', onWinch);
  return () => process.off('SIGWINCH', onWinch);
}

function waitForPtyExit(
  source: ReturnType<typeof ptyCapture>,
  resolver: ResolverHolder,
): Promise<number> {
  return new Promise<number>((resolve) => {
    resolver.current = resolve;
    let shuttingDown = false;
    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void source.stop().finally(() => resolve(code));
    };
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));
    setShutdownRef(shutdown);
  });
}

function teardownStdin(bridge: { stdin: NodeJS.ReadStream; wasRaw: boolean; onStdin: (c: Buffer | string) => void }, offWinch: () => void): void {
  offWinch();
  bridge.stdin.off('data', bridge.onStdin);
  if (bridge.stdin.isTTY) {
    try { bridge.stdin.setRawMode(bridge.wasRaw); } catch { /* ignore */ }
  }
}

export async function startShare(options: StartOptions, io: IO): Promise<number> {
  const sessionLabel = options.command.length > 0 ? options.command.join(' ') : undefined;
  const minted = await mintShareRuntime(options, io, sessionLabel);
  if (!minted.ok) return minted.code;
  const { runtime } = minted;
  const { created } = runtime;
  const cmd = getCommandToRun(options);
  const size = getTermSize();
  const holder: PtyHolder = { current: null };
  const resolver: ResolverHolder = { current: null };
  const source = createPtySource(cmd, size, holder, resolver);
  try {
    await startPtySource(
      source,
      (data) => {
        process.stdout.write(data);
        try { created.feed.publishRaw(data); } catch { /* closed */ }
      },
      (c, r) => {
        try { created.feed.publishResize(c, r); } catch { /* closed */ }
      },
    );
  } catch (err) {
    const entry = cmd[0];
    const name = entry ?? 'unknown';
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`vibeshare: could not start ${name}: ${msg}`);
    await source.stop().catch(() => undefined);
    await runtime.cleanup();
    return 2;
  }
  runtime.setInputSink((data) => { void source.write(data); });
  const bridge = setupStdinBridge(source);
  const offWinch = setupWinch(holder, created.feed);
  const exitCode = await waitForPtyExit(source, resolver);
  teardownStdin(bridge, offWinch);
  await source.stop().catch(() => undefined);
  await runtime.cleanup();
  return exitCode;
}
