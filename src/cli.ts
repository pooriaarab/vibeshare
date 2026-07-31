#!/usr/bin/env node
/**
 * vibeshare CLI.
 *
 *   vibeshare [options] [-- <cmd…>]   start sharing (default command: your shell)
 *   vibeshare viewers [--approve|--deny|--kick <viewerId>] [--json]
 *   vibeshare stop
 *
 * The share runs on your machine only: the consent ledger (@pooriaarab/vibe-core)
 * gates every share, and the spectator stream is served straight from here.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { badge, createHookBus, parseConfirm, watchCwd, type TriggerKind } from '@pooriaarab/vibe-core';
import {
  clearActiveShare,
  listActiveShares,
  loadLedger,
  readActiveShare,
  writeActiveShare,
  type ActiveShareRecord,
} from './consent.js';
import { resolveSignaling, resolveTunnel } from './config.js';
import { E2E_KEY_LEN } from './e2e.js';
import { LocalHttpTransport } from './localHttp.js';
import { ConsentRequiredError, ShareManager, SHARE_SCOPE, type CreatedShare } from './manager.js';
import { startMcp } from './mcp.js';
import type { ShareTransport } from './transport.js';
import { createTunnelRegistry } from './tunnel/index.js';
import { VERSION } from './version.js';
import { WebRtcTransport } from './webrtc/transport.js';
import { WsSignaling } from './webrtc/wsSignaling.js';

/**
 * ICE server used for `--public` shares (and baked into the viewer page).
 * Needed for NAT traversal across the internet; local/LAN peers work without
 * it. Loopback tests pass `iceServers: []` and never touch it.
 */
const DEFAULT_STUN_SERVER = 'stun:stun.l.google.com:19302';

// ---------------------------------------------------------------- parsing

export interface StartOptions {
  access: 'spectate' | 'invite';
  expiry: string;
  passphrase?: string;
  port: number;
  host: string;
  name?: string;
  yes: boolean;
  /** Share peer-to-peer over WebRTC via the signaling rendezvous. */
  public: boolean;
  /**
   * Tunnel mode: expose the local session server through a TunnelProvider.
   * - `true`  → detect-cascade (`TunnelRegistry.resolve()`)
   * - string  → that named provider (error if undetected)
   * - false   → off
   * Mutually exclusive with `--public`.
   */
  tunnel: boolean | string;
  /** `--signaling <url>` override for the rendezvous (see src/config.ts). */
  signaling?: string;
  /**
   * Injectable tunnel registry (tests). Production uses createTunnelRegistry().
   * Accepts anything with the resolve() shape so mocks stay light.
   */
  tunnelRegistry?: {
    resolve(preferred?: string): Promise<{
      name: string;
      start(port: number, opts?: { hostname?: string; serverAddr?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<{ url: string; stop(): Promise<void> }>;
    }>;
  };
  command: string[];
}

export type CliCommand =
  | { cmd: 'start'; options: StartOptions }
  | { cmd: 'stop'; share?: string }
  | { cmd: 'viewers'; share?: string; approve?: string; deny?: string; kick?: string; json: boolean }
  | { cmd: 'mcp' }
  | { cmd: 'help' }
  | { cmd: 'version' };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const USAGE = `vibeshare — share your live agent coding session by URL

usage:
  vibeshare [options] [-- <cmd…>]   start sharing (default: your shell)
  vibeshare viewers [shareId]       list viewers; act on join requests
  vibeshare stop [shareId]          end the active share

options:
  --spectate        viewers watch read-only (default)
  --invite          viewers may request to join as collaborators
  --expire <when>   1h, 24h, 7d, … or "stop" (default: until you stop)
  --pass <phrase>   require a passphrase to watch
  --public          share peer-to-peer over WebRTC; viewers watch in a browser
                    at https://getvibe.dev/vibeshare/s/<id>#<key> (end-to-end
                    encrypted — only the handshake crosses the rendezvous)
  --tunnel [name]   expose the local server via a tunnel from this machine
                    (cloudflared/ngrok/tailscale/…); end-to-end encrypted so the
                    provider sees only ciphertext. No name = detect cascade.
                    BYO accounts in ~/.vibeshare/config.json under "tunnel".
  --signaling <url> signaling rendezvous for --public (default wss://getvibe.dev/vibeshare;
                    also VIBESHARE_SIGNALING or ~/.vibeshare/config.json signalingUrl)
  --port <n>        port to serve on (default: random; local shares only)
  --host <addr>     bind address (default: 127.0.0.1; 0.0.0.0 shares on LAN; local only)
  --name <label>    what to call the session
  --yes, -y         grant share:session consent without prompting
  --json            machine-readable output (viewers)
  --approve <id>    approve a viewer's join request (viewers)
  --deny <id>       deny a join request (viewers)
  --kick <id>       remove a viewer (viewers)
  --version, -v     print version
  --help, -h        this help

local-first: the stream is served from this machine; nothing is stored on a
server. Consent scope "share:session" is recorded in ~/.vibeshare/consent.json.`;

export function parseArgv(argv: string[]): CliCommand {
  const rest = [...argv];
  const sub = rest[0];

  if (sub === '--help' || sub === '-h' || sub === 'help') return { cmd: 'help' };
  if (sub === '--version' || sub === '-v' || sub === 'version') return { cmd: 'version' };
  if (sub === 'stop') {
    const extra = positionalArgs(rest.slice(1));
    if (extra.length > 1) throw new CliUsageError('stop takes at most one share id');
    return { cmd: 'stop', ...(extra[0] !== undefined ? { share: extra[0] } : {}) };
  }
  if (sub === 'viewers') {
    const args = rest.slice(1);
    const out: { cmd: 'viewers'; share?: string; approve?: string; deny?: string; kick?: string; json: boolean } = {
      cmd: 'viewers',
      json: false,
    };
    let actions = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--json') out.json = true;
      else if (a === '--approve' || a === '--deny' || a === '--kick') {
        const id = args[++i];
        if (id === undefined) throw new CliUsageError(`${a} needs a viewer id`);
        const key = a.slice(2) as 'approve' | 'deny' | 'kick';
        out[key] = id;
        actions++;
      } else if (a.startsWith('-')) throw new CliUsageError(`unknown option for viewers: ${a}`);
      else if (out.share === undefined) out.share = a;
      else throw new CliUsageError(`unexpected argument: ${a}`);
    }
    if (actions > 1) throw new CliUsageError('use only one of --approve / --deny / --kick');
    return out;
  }
  if (sub === 'mcp') return { cmd: 'mcp' };
  if (sub === 'start') rest.shift();

  // Default: start.
  const options: StartOptions = {
    access: 'spectate',
    expiry: 'stop',
    port: 0,
    host: '127.0.0.1',
    yes: false,
    public: false,
    tunnel: false,
    command: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = (flag: string): string => {
      const v = rest[++i];
      if (v === undefined) throw new CliUsageError(`${flag} needs a value`);
      return v;
    };
    if (a === '--') {
      options.command = rest.slice(i + 1);
      break;
    } else if (a === '--spectate') options.access = 'spectate';
    else if (a === '--invite') options.access = 'invite';
    else if (a === '--public') options.public = true;
    else if (a === '--tunnel') {
      // Optional value: `--tunnel` (cascade) or `--tunnel ngrok`.
      // A following bare non-flag token is the provider name; anything
      // starting with `-` or end-of-args means cascade with no name.
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-') && next !== '--') {
        options.tunnel = rest[++i]!;
      } else {
        options.tunnel = true;
      }
    }
    else if (a === '--signaling') options.signaling = value(a);
    else if (a === '--expire' || a === '--expiry') options.expiry = value(a);
    else if (a === '--pass') options.passphrase = value(a);
    else if (a === '--port') {
      const n = Number(value(a));
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError('--port must be 0–65535');
      options.port = n;
    } else if (a === '--host') options.host = value(a);
    else if (a === '--name') options.name = value(a);
    else if (a === '--yes' || a === '-y') options.yes = true;
    else if (a === '--help' || a === '-h') return { cmd: 'help' };
    else if (a.startsWith('-')) throw new CliUsageError(`unknown option: ${a}`);
    else options.command = rest.slice(i); // bare words = command to share
    if (!a.startsWith('-')) break;
  }
  return { cmd: 'start', options };
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) throw new CliUsageError(`unknown option: ${a}`);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- io helpers

interface IO {
  out(text: string): void;
  err(text: string): void;
}

const stdio: IO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

// ---------------------------------------------------------------- start

const HOOK_KINDS: TriggerKind[] = [
  'task-done', 'pr-opened', 'prototype-finished', 'spec-completed',
  'tests-pass', 'tests-fail', 'error', 'session-end', 'manual',
];

async function ensureConsent(io: IO, yes: boolean): Promise<boolean> {
  const ledger = loadLedger();
  if (ledger.allows(SHARE_SCOPE)) return true;
  if (yes) {
    ledger.grant(SHARE_SCOPE, 'granted via vibeshare --yes');
    return true;
  }
  if (!process.stdin.isTTY) {
    io.err(`consent required: re-run with --yes to grant "${SHARE_SCOPE}" (recorded locally in ~/.vibeshare/consent.json)`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `Share this session live by URL? Anyone with the link can view its output. (y/N) `,
    );
    if (!parseConfirm(answer)) {
      io.err('aborted — no consent granted');
      return false;
    }
    ledger.grant(SHARE_SCOPE, 'granted via vibeshare CLI prompt');
    return true;
  } finally {
    rl.close();
  }
}

/** Split a stream chunk into complete lines; keeps the tail for next time. */
function lineBuffer(publish: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        publish(buf.slice(0, idx).replace(/\r$/, ''));
        buf = buf.slice(idx + 1);
      }
      if (buf.length > 8192) {
        publish(buf);
        buf = '';
      }
    },
    flush() {
      if (buf.length > 0) {
        publish(buf);
        buf = '';
      }
    },
  };
}

async function startShare(options: StartOptions, io: IO): Promise<number> {
  if (options.public && options.tunnel) {
    io.err('vibeshare: --public and --tunnel are mutually exclusive');
    return 2;
  }
  if (!(await ensureConsent(io, options.yes))) return 1;

  const bus = createHookBus({ onError: (e) => io.err(`[vibeshare] hook error: ${String(e)}`) });
  const watcher = watchCwd(process.cwd(), bus);

  let created: CreatedShare | null = null;
  // Three modes:
  //   --public → pure-P2P WebRTC (AES-GCM DataChannel; handshake via signaling)
  //   --tunnel → local HTTP + e2e AES-GCM SSE exposed via a TunnelProvider
  //   default  → local HTTP spectator server on loopback (unchanged)
  let transport: ShareTransport;
  let localHttp: LocalHttpTransport | null = null;
  let tunnelHandle: { url: string; stop(): Promise<void> } | null = null;
  let tunnelProviderName: string | null = null;
  let publicShareUrl: string | null = null;
  const tunnelOn = options.tunnel !== false;

  if (options.public) {
    const signalingUrl = resolveSignaling(options.signaling);
    transport = new WebRtcTransport({
      signaling: new WsSignaling({
        url: signalingUrl,
        onError: (e) => io.err(`[vibeshare] signaling: ${e.message}`),
      }),
      iceServers: [DEFAULT_STUN_SERVER],
      // The viewer page is served by the rendezvous itself at /vibeshare/s/<id>
      // — the share URL is the ws endpoint with an http(s) scheme.
      baseUrl: signalingUrl.replace(/^ws/, 'http'),
    });
  } else if (tunnelOn) {
    // Fresh per-share key — tunnel provider never sees it (URL #fragment only).
    const e2eKey = randomBytes(E2E_KEY_LEN);
    localHttp = new LocalHttpTransport({
      // Always bind loopback for tunnel mode — the provider is what punches out.
      host: '127.0.0.1',
      port: options.port,
      e2e: { key: e2eKey },
      onStopRequested: () => {
        shutdown(0);
      },
    });
    transport = localHttp;
  } else {
    localHttp = new LocalHttpTransport({
      host: options.host,
      port: options.port,
      onStopRequested: () => {
        // `vibeshare stop` from another process → shut this one down.
        shutdown(0);
      },
    });
    transport = localHttp;
  }
  const manager = new ShareManager({ consent: loadLedger(), transport });

  try {
    created = await manager.createShare({
      access: options.access,
      expiry: options.expiry,
      ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      session: options.command.length > 0 ? options.command.join(' ') : undefined,
    });
  } catch (err) {
    watcher.stop();
    await transport.close();
    if (err instanceof ConsentRequiredError || err instanceof Error) {
      io.err(`vibeshare: ${err.message}`);
      return err instanceof ConsentRequiredError ? 1 : 2;
    }
    throw err;
  }

  if (tunnelOn && localHttp) {
    try {
      const resolved = resolveTunnel(
        options.tunnel === true ? true : typeof options.tunnel === 'string' ? options.tunnel : undefined,
      );
      const registry = options.tunnelRegistry ?? createTunnelRegistry();
      const provider = await registry.resolve(resolved.provider);
      tunnelProviderName = provider.name;
      // Local URL looks like http://127.0.0.1:PORT/s/ID#KEY — only path+fragment survive.
      const localUrl = new URL(created.url.replace(/#.*$/, '')); // strip fragment for URL parsing
      const fragment = created.url.includes('#') ? created.url.slice(created.url.indexOf('#') + 1) : '';
      tunnelHandle = await provider.start(localHttp.port, resolved.startOpts);
      const publicBase = tunnelHandle.url.replace(/\/$/, '');
      publicShareUrl = `${publicBase}${localUrl.pathname}${fragment ? `#${fragment}` : ''}`;
      // Rewrite so viewers / the state file point at the public URL.
      created = { ...created, url: publicShareUrl };
    } catch (err) {
      watcher.stop();
      clearActiveShare(created.share.id);
      await manager.stopAll();
      const msg = err instanceof Error ? err.message : String(err);
      // Never echo secrets — startOpts.env is not in the error path.
      io.err(`vibeshare: tunnel failed: ${msg}`);
      return 2;
    }
  }

  // Milestones from the vibe-core watcher floor (commits, sentinel signals).
  for (const kind of HOOK_KINDS) {
    bus.on(kind, (e) => {
      created?.feed.publishEvent(e);
    });
  }

  const record: ActiveShareRecord = {
    id: created.share.id,
    url: created.url,
    port: localHttp?.port ?? 0,
    hostToken: localHttp?.hostToken ?? '',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    transport: options.public ? 'webrtc' : tunnelOn ? 'tunnel' : 'local-http',
  };
  writeActiveShare(record);

  const loopback = !options.public && !tunnelOn && (options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1');
  // vibe-core badge() only knows 'local' | 'p2p' today; tunnel reuses p2p chrome.
  io.out(`${badge(loopback ? 'local' : 'p2p')}`);
  io.out(`  sharing:  ${created.share.name}`);
  io.out(`  url:      ${created.url}`);
  io.out(`  access:   ${created.share.access}${created.share.access === 'spectate' ? ' (read-only)' : ' (viewers may request to join)'}`);
  io.out(`  expires:  ${created.share.expiresAt ?? 'until you stop'}`);
  if (created.share.passphraseHash) io.out(`  pass:     required`);
  if (options.public) io.out(`  mode:     public · end-to-end encrypted p2p (only the handshake crosses the rendezvous)`);
  if (tunnelOn && tunnelProviderName) {
    io.out(`  mode:     tunnel · end-to-end encrypted (provider: ${tunnelProviderName})`);
    io.out(`  provider: ${tunnelProviderName}`);
  }
  io.out(`  manage:   vibeshare viewers · vibeshare stop`);
  if (!loopback && !options.public && !tunnelOn) io.err('note: bound to a non-loopback address — anyone who can reach this host with the link can watch.');

  // Spawn the session being shared and tee its output into the feed.
  const cmd = options.command.length > 0 ? options.command : [process.env['SHELL'] ?? '/bin/sh'];
  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });
  const outLines = lineBuffer((l) => created?.feed.publish(l, { stream: 'stdout' }));
  const errLines = lineBuffer((l) => created?.feed.publish(l, { stream: 'stderr' }));
  child.stdout?.on('data', (d: Buffer) => {
    process.stdout.write(d);
    outLines.push(d.toString('utf8'));
  });
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d);
    errLines.push(d.toString('utf8'));
  });

  let shuttingDown = false;
  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      io.err(`vibeshare: could not start ${cmd[0]!}: ${err.message}`);
      resolve(2);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal !== null ? 128 : 0));
    });
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));

    function shutdown(code: number): void {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill('SIGTERM');
      resolve(code);
    }
    // Expose to onStopRequested above.
    shutdownRef = shutdown;
  });

  outLines.flush();
  errLines.flush();
  watcher.stop();
  clearActiveShare(record.id);
  await manager.stopAll();
  if (tunnelHandle) {
    try { await tunnelHandle.stop(); } catch { /* best effort */ }
    tunnelHandle = null;
  }
  return exitCode;
}

// Control-stop callback set once startShare is running.
let shutdownRef: ((code: number) => void) | null = null;
function shutdown(code: number): void {
  shutdownRef?.(code);
}

// ------------------------------------------------------- viewers / stop

async function controlFetch<T>(
  record: ActiveShareRecord,
  path: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${record.port}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${record.hostToken}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, message: 'connection refused' };
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, string>)['error']!
      : `HTTP ${res.status}`;
    return { ok: false, status: res.status, message };
  }
  return { ok: true, data: body as T };
}

function resolveRecord(shareId: string | undefined, io: IO): ActiveShareRecord | null {
  if (shareId !== undefined) {
    const rec = readActiveShare(shareId);
    if (rec) return rec;
    io.err(`no recorded share ${shareId}`);
    return null;
  }
  const [latest] = listActiveShares();
  if (!latest) {
    io.err('no active vibeshare share — start one with `vibeshare`');
    return null;
  }
  return latest;
}

interface ViewerInfo {
  id: string;
  name: string;
  role: string;
  joinRequest: string;
  joinedAt: string;
}

async function viewersCommand(
  cmd: Extract<CliCommand, { cmd: 'viewers' }>,
  io: IO,
): Promise<number> {
  const record = resolveRecord(cmd.share, io);
  if (!record) return 1;

  // --public shares have no local control server: viewers connect p2p to the
  // host and the registry lives only in the sharing process's memory.
  if (record.transport === 'webrtc') {
    if (cmd.approve !== undefined || cmd.deny !== undefined || cmd.kick !== undefined) {
      io.err('vibeshare: approve/deny/kick is not available for --public shares yet (collaborator approval over p2p lands in a later slice)');
      return 1;
    }
    io.out(`${record.url}`);
    io.out('  public p2p share — viewers connect end-to-end encrypted; live viewer management is only available for local shares');
    return 0;
  }

  const action = cmd.approve !== undefined ? 'approve' : cmd.deny !== undefined ? 'deny' : cmd.kick !== undefined ? 'kick' : null;
  const target = cmd.approve ?? cmd.deny ?? cmd.kick;

  if (action !== null && target !== undefined) {
    const res = await controlFetch<{ viewer: ViewerInfo }>(record, `/control/${action}`, {
      method: 'POST',
      body: { share: record.id, viewer: target },
    });
    if (!res.ok) {
      if (res.status === 0) clearActiveShare(record.id);
      io.err(`vibeshare: could not ${action} ${target}: ${res.message}`);
      return 1;
    }
    const v = res.data.viewer;
    io.out(
      action === 'approve' ? `✓ approved ${v.name} — now a collaborator`
      : action === 'deny' ? `✓ denied ${v.name} — stays a spectator`
      : `✓ kicked ${v.name}`,
    );
    return 0;
  }

  const res = await controlFetch<{ viewers: ViewerInfo[]; watching: number }>(
    record,
    `/control/viewers?share=${encodeURIComponent(record.id)}`,
  );
  if (!res.ok) {
    if (res.status === 0) {
      clearActiveShare(record.id);
      io.err('vibeshare: the share process is not running (stale record cleaned up)');
    } else {
      io.err(`vibeshare: ${res.message}`);
    }
    return 1;
  }
  if (cmd.json) {
    io.out(JSON.stringify(res.data, null, 2));
    return 0;
  }
  io.out(`${record.url}`);
  if (res.data.viewers.length === 0) {
    io.out('  no viewers yet');
    return 0;
  }
  for (const v of res.data.viewers) {
    const pending = v.joinRequest === 'pending' ? '  ⏳ requested to join — vibeshare viewers --approve ' + v.id : '';
    io.out(`  ${v.id}  ${v.name}  [${v.role}]${pending}`);
  }
  io.out(`  ${res.data.watching} watching now`);
  return 0;
}

async function stopCommand(cmd: Extract<CliCommand, { cmd: 'stop' }>, io: IO): Promise<number> {
  const record = resolveRecord(cmd.share, io);
  if (!record) return 1;
  // --public shares have no control server to POST to: signal the process.
  if (record.transport === 'webrtc') {
    try {
      process.kill(record.pid, 'SIGTERM');
      clearActiveShare(record.id);
      io.out(`✓ stopped ${record.url}`);
    } catch {
      clearActiveShare(record.id);
      io.err('vibeshare: the share process was not running (record cleaned up)');
    }
    return 0;
  }
  const res = await controlFetch<{ stopped: string }>(record, '/control/stop', {
    method: 'POST',
    body: { share: record.id },
  });
  clearActiveShare(record.id);
  if (!res.ok) {
    io.err(res.status === 0 ? 'vibeshare: the share process was not running (record cleaned up)' : `vibeshare: ${res.message}`);
    return res.status === 0 ? 0 : 1;
  }
  io.out(`✓ stopped ${record.url}`);
  return 0;
}

// ---------------------------------------------------------------- main

/** Dispatch a parsed command (exported so tests can inject StartOptions seams). */
export async function runCommand(command: CliCommand, io: IO = stdio): Promise<number> {
  switch (command.cmd) {
    case 'help':
      io.out(USAGE);
      return 0;
    case 'version':
      io.out(`vibeshare ${VERSION}`);
      return 0;
    case 'mcp':
      await startMcp();
      return 0;
    case 'start':
      return startShare(command.options, io);
    case 'viewers':
      return viewersCommand(command, io);
    case 'stop':
      return stopCommand(command, io);
  }
}

export async function run(argv: string[], io: IO = stdio): Promise<number> {
  let command: CliCommand;
  try {
    command = parseArgv(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.err(`vibeshare: ${err.message}\n`);
      io.err(USAGE);
      return 2;
    }
    throw err;
  }
  return runCommand(command, io);
}

/* c8 ignore next 3 — entry guard */
// Resolve the symlink first: under a global/npx bin, argv[1] is a symlink into
// node_modules/.bin, so comparing to the real module path fails without realpath.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('vibeshare:', err);
      process.exit(1);
    },
  );
}
