/**
 * TunnelProvider — uniform interface over every way vibeshare can expose a
 * local port to a remote viewer.
 *
 * The tunnel only ever relays ciphertext (a separate AES-GCM layer owns the
 * payload). Providers spawn a child process, scrape a public URL from its
 * stdout/stderr, and yield a handle that can tear the child down.
 *
 * Providers accept an optional spawn/detect seam so unit tests never open a
 * real network socket or fork a real tunnel binary.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Live tunnel: a public URL plus a way to stop the underlying process. */
export interface TunnelHandle {
  readonly url: string;
  stop(): Promise<void>;
}

/** Options accepted by every provider's `start`. */
export interface TunnelStartOpts {
  /** Preferred public hostname (cloudflared named tunnel, frp server, …). */
  readonly hostname?: string;
  /** Abort an in-flight start (kills the child and rejects). */
  readonly signal?: AbortSignal;
  /** Override the default ~20s “wait for URL” timeout. */
  readonly timeoutMs?: number;
  /**
   * Self-hosted frp server address (`host` or `host:port`). Required for the
   * frp provider when `FRP_SERVER_ADDR` is not set.
   */
  readonly serverAddr?: string;
}

/**
 * One tunnel backend. `name` is the stable id used by `--tunnel <name>` and
 * the registry cascade.
 */
export interface TunnelProvider {
  readonly name: string;
  /** True when this backend is usable on the current machine. */
  detect(): Promise<boolean>;
  /** Spawn the tunnel and resolve once the public URL is known. */
  start(port: number, opts?: TunnelStartOpts): Promise<TunnelHandle>;
}

/**
 * Minimal child-process shape the tunnel helpers need. Matches node’s
 * `ChildProcess` closely enough that real `spawn` and test fakes both work.
 */
export interface TunnelChildProcess {
  readonly pid?: number;
  readonly killed: boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

/** spawner seam — defaults to `child_process.spawn`. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => TunnelChildProcess | ChildProcess;

/** PATH lookup seam — defaults to scanning `process.env.PATH`. */
export type CommandExistsFn = (command: string) => Promise<boolean>;

/** Injectable deps every provider factory accepts. */
export interface ProviderDeps {
  readonly spawn?: SpawnImpl;
  readonly commandExists?: CommandExistsFn;
  /**
   * Base URL for the getvibe placeholder provider
   * (default `https://getvibe.dev`).
   */
  readonly getvibeBaseUrl?: string;
  /**
   * Override env lookup for frp (and any other env-gated providers). Defaults
   * to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
}
