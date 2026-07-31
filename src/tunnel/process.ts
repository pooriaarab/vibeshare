/**
 * Shared “spawn a CLI, scrape a public URL from its output, return a handle”
 * helper used by every process-backed TunnelProvider.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  ProviderDeps,
  SpawnImpl,
  TunnelChildProcess,
  TunnelHandle,
  TunnelStartOpts,
} from './provider.js';

/** Default how long we wait for a public URL line before rejecting. */
export const DEFAULT_START_TIMEOUT_MS = 20_000;

export interface StartProcessTunnelOpts {
  readonly command: string;
  readonly args: readonly string[];
  /** Matched against each stdout/stderr chunk (and a rolling buffer). */
  readonly urlRegex: RegExp;
  /**
   * Map a regex match to the public URL. Defaults to match[0], or match[1]
   * when a capture group is present.
   */
  readonly mapUrl?: (match: RegExpExecArray) => string;
  readonly deps?: ProviderDeps;
  readonly opts?: TunnelStartOpts;
  readonly env?: NodeJS.ProcessEnv;
  /** Spawn with a shell (rarely needed; prefer argv arrays). */
  readonly shell?: boolean;
}

/**
 * Spawn `command`, resolve with a {@link TunnelHandle} once `urlRegex` hits
 * stdout or stderr. Rejects on timeout, abort, spawn error, or early exit.
 */
export async function startProcessTunnel(params: StartProcessTunnelOpts): Promise<TunnelHandle> {
  const spawnImpl: SpawnImpl = params.deps?.spawn ?? (nodeSpawn as SpawnImpl);
  const timeoutMs = params.opts?.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const signal = params.opts?.signal;

  if (signal?.aborted) {
    throw new Error(`tunnel start aborted before spawn (${params.command})`);
  }

  const child = spawnImpl(params.command, [...params.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(params.env ?? {}),
      ...(params.opts?.env ?? {}),
    },
    shell: params.shell ?? false,
  }) as TunnelChildProcess;

  let settled = false;
  let buffer = '';
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const cleanupListeners = (): void => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
  };

  const killChild = async (): Promise<void> => {
    if (child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // Best-effort hard kill if still alive shortly after.
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  };

  return new Promise<TunnelHandle>((resolve, reject) => {
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      void killChild().finally(() => reject(err));
    };

    const succeed = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        url,
        stop: async () => {
          await killChild();
        },
      });
    };

    const consider = (chunk: string): void => {
      buffer += chunk;
      // Keep the buffer bounded so a chatty CLI can't blow memory.
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
      params.urlRegex.lastIndex = 0;
      const match = params.urlRegex.exec(buffer);
      if (!match) return;
      const url = params.mapUrl
        ? params.mapUrl(match)
        : match[1]
          ? match[1]
          : match[0];
      succeed(url.replace(/\/$/, ''));
    };

    child.stdout?.on('data', (d: Buffer | string) => consider(String(d)));
    child.stderr?.on('data', (d: Buffer | string) => consider(String(d)));

    child.on('error', (err: Error) => {
      fail(new Error(`failed to spawn ${params.command}: ${err.message}`));
    });

    child.on('exit', (code, sig) => {
      if (settled) return;
      fail(
        new Error(
          `${params.command} exited before publishing a public URL` +
            ` (code=${code ?? 'null'}, signal=${sig ?? 'null'})`,
        ),
      );
    });

    timeoutId = setTimeout(() => {
      fail(
        new Error(
          `timed out after ${timeoutMs}ms waiting for ${params.command} public URL`,
        ),
      );
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        fail(new Error(`tunnel start aborted (${params.command})`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
