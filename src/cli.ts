#!/usr/bin/env node
/**
 * vibeshare CLI.
 *
 *   vibeshare [options] [-- <cmd…>]   start sharing any harness/shell (default: your shell)
 *   vibeshare attach [target]         share an already-running tmux pane (harness-agnostic)
 *   vibeshare viewers [--approve|--deny|--kick <viewerId>] [--json]
 *   vibeshare stop
 *
 * The share runs on your machine only: the consent ledger (@pooriaarab/vibe-core)
 * gates every share, and the spectator stream is served straight from here.
 *
 * Capture MECHANISM (PTY spawn / tmux attach) comes from
 * `@pooriaarab/vibe-core/capture`; attach POLICY stays in src/attach.ts.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as pty from 'node-pty';
import {
  badge,
  createHookBus,
  createTunnelRegistry,
  E2E_KEY_LEN,
  parseConfirm,
  sanitizePeerText,
  watchCwd,
  type TriggerKind,
} from '@pooriaarab/vibe-core';
import {
  CaptureError,
  ptyCapture,
  type PtyProcess,
} from '@pooriaarab/vibe-core/capture';
import {
  AttachError,
  createProcessTmuxClient,
  createTmuxCaptureSource,
  pickAttachTarget,
  type TmuxClient,
} from './attach.js';
import { decryptChatText } from './presenceChatCrypto.js';
import { decryptAnnotationText } from './annotationsCrypto.js';
import {
  clearActiveShare,
  listActiveShares,
  loadLedger,
  readActiveShare,
  writeActiveShare,
  type ActiveShareRecord,
} from './consent.js';
import { resolveSignaling, resolveTunnel } from './config.js';
import { HostControlServer } from './hostControl.js';
import { LocalHttpTransport } from './localHttp.js';
import { ConsentRequiredError, ShareManager, SHARE_SCOPE, type CreatedShare } from './manager.js';
import { startMcp } from './mcp.js';
import type { ShareTransport } from './transport.js';
import type { Viewer } from './types.js';
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

/** Share flags common to `start` (PTY) and `attach` (tmux). */
export interface ShareFlags {
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
}

export interface StartOptions extends ShareFlags {
  command: string[];
}

export interface AttachCliOptions extends ShareFlags {
  /** tmux target (`session:window.pane` / `%id`). Omitted → $TMUX_PANE or picker. */
  target?: string;
  /** Injectable tmux client (tests). */
  tmux?: TmuxClient;
  /** Pane-size poll interval ms (tests may set 0 to disable). */
  sizePollMs?: number;
}

export type CliCommand =
  | { cmd: 'start'; options: StartOptions }
  | { cmd: 'attach'; options: AttachCliOptions }
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
  vibeshare [options] [-- <cmd…>]   start sharing any harness/shell (default: your shell)
  vibeshare attach [target] [opts]  share an already-running tmux pane (harness-agnostic)
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

attach:
  target is a tmux pane id (session:window.pane or %pane_id). Omit it to use
  $TMUX_PANE when inside tmux, or to list panes. --invite enables drive via send-keys.
  Needs tmux — GNU screen is not supported yet. To share a fresh command instead:
    vibeshare -- <cmd>

local-first: the stream is served from this machine; nothing is stored on a
server. Consent scope "share:session" is recorded in ~/.vibeshare/consent.json.`;

function defaultShareFlags(): ShareFlags {
  return {
    access: 'spectate',
    expiry: 'stop',
    port: 0,
    host: '127.0.0.1',
    yes: false,
    public: false,
    tunnel: false,
  };
}

/**
 * Parse shared start/attach flags from argv.
 * Returns the next index after the last consumed flag token, plus any bare
 * positional args collected (attach target, or start command words).
 */
function parseShareFlags(
  args: string[],
  opts: ShareFlags,
): { positionals: string[]; commandAfterDashDash: string[] | null } {
  const positionals: string[] = [];
  let commandAfterDashDash: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (flag: string): string => {
      const v = args[++i];
      if (v === undefined) throw new CliUsageError(`${flag} needs a value`);
      return v;
    };
    if (a === '--') {
      commandAfterDashDash = args.slice(i + 1);
      break;
    } else if (a === '--spectate') opts.access = 'spectate';
    else if (a === '--invite') opts.access = 'invite';
    else if (a === '--public') opts.public = true;
    else if (a === '--tunnel') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-') && next !== '--') {
        opts.tunnel = args[++i]!;
      } else {
        opts.tunnel = true;
      }
    } else if (a === '--signaling') opts.signaling = value(a);
    else if (a === '--expire' || a === '--expiry') opts.expiry = value(a);
    else if (a === '--pass') opts.passphrase = value(a);
    else if (a === '--port') {
      const n = Number(value(a));
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError('--port must be 0–65535');
      opts.port = n;
    } else if (a === '--host') opts.host = value(a);
    else if (a === '--name') opts.name = value(a);
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--help' || a === '-h') {
      // Caller maps this; throw a sentinel via special positional.
      throw new HelpRequested();
    } else if (a.startsWith('-')) throw new CliUsageError(`unknown option: ${a}`);
    else positionals.push(a);
  }
  return { positionals, commandAfterDashDash };
}

class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

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

  // attach [target] [share flags…]
  if (sub === 'attach') {
    const flags = defaultShareFlags();
    try {
      const { positionals, commandAfterDashDash } = parseShareFlags(rest.slice(1), flags);
      if (commandAfterDashDash !== null) {
        throw new CliUsageError('attach does not take `-- <cmd>` — pass a tmux target, or use `vibeshare -- <cmd>` to launch wrapped');
      }
      if (positionals.length > 1) {
        throw new CliUsageError('attach takes at most one target (session:window.pane)');
      }
      const options: AttachCliOptions = {
        ...flags,
        ...(positionals[0] !== undefined ? { target: positionals[0] } : {}),
      };
      return { cmd: 'attach', options };
    } catch (err) {
      if (err instanceof HelpRequested) return { cmd: 'help' };
      throw err;
    }
  }

  if (sub === 'start') rest.shift();

  // Default: start.
  const options: StartOptions = {
    ...defaultShareFlags(),
    command: [],
  };
  try {
    const { positionals, commandAfterDashDash } = parseShareFlags(rest, options);
    if (commandAfterDashDash !== null) {
      options.command = commandAfterDashDash;
    } else if (positionals.length > 0) {
      options.command = positionals;
    }
  } catch (err) {
    if (err instanceof HelpRequested) return { cmd: 'help' };
    throw err;
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

/**
 * Where gated collaborator input is applied. Set by startShare (PTY write) or
 * attachShare (tmux send-keys) after the capture source is live. Transports
 * only call this after ViewerRegistry.canWrite(viewerId) is true.
 */
export type SessionInputSink = (data: string) => void;

/** Runtime produced by mintShareRuntime — shared by start (PTY) and attach (tmux). */
interface ShareRuntime {
  created: CreatedShare;
  manager: ShareManager;
  record: ActiveShareRecord;
  tunnelHandle: { url: string; stop(): Promise<void> } | null;
  watcher: { stop(): void };
  tunnelOn: boolean;
  tunnelProviderName: string | null;
  /**
   * Install the live session input sink (PTY.write / tmux send-keys).
   * Called once the capture source is up; cleared on cleanup.
   */
  setInputSink(sink: SessionInputSink | null): void;
  /** Tear down transport + state. Idempotent enough for error paths. */
  cleanup(): Promise<void>;
}

/**
 * Mint the share + transport exactly once for both capture sources.
 * Returns null and has already printed + cleaned up on failure (exit code set).
 */
async function mintShareRuntime(
  options: ShareFlags,
  io: IO,
  sessionLabel: string | undefined,
): Promise<{ ok: true; runtime: ShareRuntime } | { ok: false; code: number }> {
  if (options.public && options.tunnel) {
    io.err('vibeshare: --public and --tunnel are mutually exclusive');
    return { ok: false, code: 2 };
  }
  if (!(await ensureConsent(io, options.yes))) return { ok: false, code: 1 };

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
  const tunnelOn = options.tunnel !== false;

  /** Print incoming chat to the host terminal without breaking session output. */
  const printChat = (name: string, text: string): void => {
    const who = sanitizePeerText(name, 32).trim() || 'viewer';
    const msg = sanitizePeerText(text, 500);
    if (!msg) return;
    // Dim line so it doesn't fight the session TUI; leading \r keeps raw-mode tidy.
    io.err(`\r\x1b[2m[chat] ${who}: ${msg}\x1b[0m`);
  };

  /** Print incoming annotations (pinned feedback) with their feed-seq anchor. */
  const printAnnotation = (name: string, seq: number, text: string): void => {
    const who = sanitizePeerText(name, 32).trim() || 'viewer';
    const msg = sanitizePeerText(text, 500);
    if (!msg) return;
    io.err(`\r\x1b[2m[annotation @${seq}] ${who}: ${msg}\x1b[0m`);
  };

  let publicSignaling: WsSignaling | null = null;
  // Filled after createShare for --public (key lives in the URL #fragment).
  let publicShareKey: Buffer | null = null;
  // Live session write target — installed by startShare/attachShare once the
  // PTY or tmux capture is up. Transports only call this after canWrite.
  let inputSink: SessionInputSink | null = null;
  const applyInput: SessionInputSink = (data) => {
    try {
      inputSink?.(data);
    } catch {
      /* session closed mid-write */
    }
  };
  const printJoinRequest = (_shareId: string, viewer: Viewer): void => {
    const who = sanitizePeerText(viewer.name, 32).trim() || 'viewer';
    io.err(
      `\r\x1b[2m[join] ${who} wants to drive — approve: vibeshare viewers --approve ${viewer.id}\x1b[0m`,
    );
  };
  // Loopback control for --public (viewers/approve/stop). Local-http already
  // exposes /control/* on its own server.
  let hostControl: HostControlServer | null = null;

  if (options.public) {
    const signalingUrl = resolveSignaling(options.signaling);
    // Presence binds hub-minted viewerIds into the host registry so canWrite
    // tracks the SAME id the Worker stamps on input frames.
    const bindPresence = (frame: { viewers: ReadonlyArray<{ viewerId: string; name: string; role: string }> }): void => {
      if (!created) return;
      for (const row of frame.viewers) {
        if (row.role === 'host' || row.viewerId === 'host') continue;
        created.viewers.ensure(row.viewerId, row.name);
      }
    };
    publicSignaling = new WsSignaling({
      url: signalingUrl,
      onError: (e) => io.err(`[vibeshare] signaling: ${e.message}`),
      onPresence: bindPresence,
      onChat: (frame) => {
        // Decrypt with the share key once we have the created URL fragment.
        // Until createShare returns the key is unknown — drop early frames.
        const key = publicShareKey;
        if (!key) return;
        const plain = decryptChatText(key, frame.text);
        if (plain) printChat(frame.name, plain);
      },
      onAnnotation: (frame) => {
        // Same e2e rule as chat: ciphertext until the share key is known.
        const key = publicShareKey;
        if (!key) return;
        const plain = decryptAnnotationText(key, frame.text);
        if (plain) printAnnotation(frame.name, frame.seq, plain);
      },
      onJoinRequest: (frame) => {
        if (!created) return;
        // Spectate shares reject at the registry; invite shares go pending.
        try {
          const v = created.viewers.ensure(frame.viewerId, frame.name);
          created.viewers.requestJoin(v.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          io.err(`\r\x1b[2m[join] ${sanitizePeerText(frame.name, 32) || 'viewer'}: ${msg}\x1b[0m`);
        }
      },
    });
    transport = new WebRtcTransport({
      signaling: publicSignaling,
      iceServers: [DEFAULT_STUN_SERVER],
      // The viewer page is served by the rendezvous itself at /vibeshare/s/<id>
      // — the share URL is the ws endpoint with an http(s) scheme.
      baseUrl: signalingUrl.replace(/^ws/, 'http'),
      onInput: (_shareId, _viewerId, data) => applyInput(data),
    });
    hostControl = new HostControlServer({
      onStopRequested: () => {
        shutdown(0);
      },
    });
    await hostControl.listen();
  } else if (tunnelOn) {
    // Fresh per-share key — tunnel provider never sees it (URL #fragment only).
    const e2eKey = randomBytes(E2E_KEY_LEN);
    localHttp = new LocalHttpTransport({
      // Always bind loopback for tunnel mode — the provider is what punches out.
      host: '127.0.0.1',
      port: options.port,
      e2e: { key: e2eKey },
      onChat: (_shareId, frame) => printChat(frame.name, frame.text),
      onAnnotation: (_shareId, frame) => printAnnotation(frame.name, frame.seq, frame.text),
      onInput: (_shareId, _viewerId, data) => applyInput(data),
      onJoinRequest: printJoinRequest,
      onStopRequested: () => {
        shutdown(0);
      },
    });
    transport = localHttp;
  } else {
    localHttp = new LocalHttpTransport({
      host: options.host,
      port: options.port,
      onChat: (_shareId, frame) => printChat(frame.name, frame.text),
      onAnnotation: (_shareId, frame) => printAnnotation(frame.name, frame.seq, frame.text),
      onInput: (_shareId, _viewerId, data) => applyInput(data),
      onJoinRequest: printJoinRequest,
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
      session: sessionLabel,
    });
    // --public: pull the share key from the URL fragment for chat decrypt, and
    // announce the host display name on the multi-party presence roster.
    if (options.public && publicSignaling) {
      const frag = created.url.includes('#') ? created.url.slice(created.url.indexOf('#') + 1) : '';
      if (frag) {
        try {
          publicShareKey = Buffer.from(frag, 'base64url');
        } catch {
          publicShareKey = null;
        }
      }
      publicSignaling.setHostName(created.share.id, created.share.name || 'host');
      if (hostControl) hostControl.track({ id: created.share.id, viewers: created.viewers });
      // Approve/deny must notify the viewer over the hub so their UI flips.
      const shareId = created.share.id;
      const signaling = publicSignaling;
      created.viewers.on('request', (v) => printJoinRequest(shareId, v));
      created.viewers.on('approve', (v) => {
        signaling.sendRoleUpdate(shareId, {
          viewerId: v.id,
          role: 'collaborator',
          joinRequest: 'approved',
        });
      });
      created.viewers.on('deny', (v) => {
        signaling.sendRoleUpdate(shareId, {
          viewerId: v.id,
          role: 'spectator',
          joinRequest: 'denied',
        });
      });
    }
  } catch (err) {
    watcher.stop();
    await transport.close();
    if (err instanceof ConsentRequiredError || err instanceof Error) {
      io.err(`vibeshare: ${err.message}`);
      return { ok: false, code: err instanceof ConsentRequiredError ? 1 : 2 };
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
      const publicShareUrl = `${publicBase}${localUrl.pathname}${fragment ? `#${fragment}` : ''}`;
      // Rewrite so viewers / the state file point at the public URL.
      created = { ...created, url: publicShareUrl };
    } catch (err) {
      watcher.stop();
      clearActiveShare(created.share.id);
      await manager.stopAll();
      const msg = err instanceof Error ? err.message : String(err);
      // Never echo secrets — startOpts.env is not in the error path.
      io.err(`vibeshare: tunnel failed: ${msg}`);
      return { ok: false, code: 2 };
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
    port: localHttp?.port ?? hostControl?.port ?? 0,
    hostToken: localHttp?.hostToken ?? hostControl?.hostToken ?? '',
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

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    inputSink = null;
    watcher.stop();
    clearActiveShare(record.id);
    await manager.stopAll();
    if (hostControl) {
      try { await hostControl.close(); } catch { /* best effort */ }
      hostControl = null;
    }
    if (tunnelHandle) {
      try { await tunnelHandle.stop(); } catch { /* best effort */ }
      tunnelHandle = null;
    }
  };

  return {
    ok: true,
    runtime: {
      created,
      manager,
      record,
      get tunnelHandle() { return tunnelHandle; },
      watcher,
      tunnelOn,
      tunnelProviderName,
      setInputSink(sink: SessionInputSink | null) {
        inputSink = sink;
      },
      cleanup,
    },
  };
}

async function startShare(options: StartOptions, io: IO): Promise<number> {
  const sessionLabel = options.command.length > 0 ? options.command.join(' ') : undefined;
  const minted = await mintShareRuntime(options, io, sessionLabel);
  if (!minted.ok) return minted.code;
  const { runtime } = minted;
  const { created } = runtime;

  // Spawn via vibe-core ptyCapture. Host POLICY stays here: tee to the local
  // terminal, host stdin → PTY, SIGWINCH resize, exit-code plumbing. The
  // injectable spawner keeps a handle for resize/onExit (not on CaptureSource).
  const cmd = options.command.length > 0 ? options.command : [process.env['SHELL'] ?? '/bin/sh'];
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  let ptyProcess: PtyProcess | null = null;
  let exitResolver: ((code: number) => void) | null = null;
  const source = ptyCapture(cmd[0]!, cmd.slice(1), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    spawner: {
      spawn(file, args, spawnOpts) {
        const p = pty.spawn(file, args as string[], spawnOpts);
        ptyProcess = p;
        p.onExit(({ exitCode: code, signal }) => {
          exitResolver?.(typeof code === 'number' ? code : (signal ? 128 : 0));
        });
        return p;
      },
    },
  });

  try {
    await source.start(
      (data) => {
        process.stdout.write(data);
        try { created.feed.publishRaw(data); } catch { /* feed closed */ }
      },
      (c, r) => {
        try { created.feed.publishResize(c, r); } catch { /* feed closed */ }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`vibeshare: could not start ${cmd[0]!}: ${msg}`);
    await source.stop().catch(() => undefined);
    await runtime.cleanup();
    return 2;
  }

  // Approved collaborator input → PTY stdin (transport already gated canWrite).
  runtime.setInputSink((data) => {
    void source.write(data);
  });

  // Host stdin → PTY so the host user still drives the session normally.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) {
    try { stdin.setRawMode(true); } catch { /* non-tty pipes */ }
  }
  stdin.resume();
  const onStdin = (chunk: Buffer | string): void => {
    void source.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  stdin.on('data', onStdin);

  const onWinch = (): void => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 24;
    try { ptyProcess?.resize(c, r); } catch { /* closed */ }
    try { created.feed.publishResize(c, r); } catch { /* feed closed */ }
  };
  process.on('SIGWINCH', onWinch);

  let shuttingDown = false;
  const exitCode = await new Promise<number>((resolve) => {
    exitResolver = resolve;
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));

    function shutdown(code: number): void {
      if (shuttingDown) return;
      shuttingDown = true;
      void source.stop().finally(() => resolve(code));
    }
    // Expose to onStopRequested above.
    shutdownRef = shutdown;
  });

  process.off('SIGWINCH', onWinch);
  stdin.off('data', onStdin);
  if (stdin.isTTY) {
    try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
  }
  await source.stop().catch(() => undefined);
  await runtime.cleanup();
  return exitCode;
}

/**
 * `vibeshare attach [target]` — share an already-running tmux pane.
 * Capture source only; transports/e2e/xterm/presence-chat are unchanged.
 * Approved collaborator input is applied via `tmux send-keys -l`.
 */
async function attachShare(options: AttachCliOptions, io: IO): Promise<number> {
  const tmux = options.tmux ?? createProcessTmuxClient();

  let target: string;
  try {
    target = await pickAttachTarget(options.target, tmux);
    // Fail closed on bad target BEFORE minting a share URL.
    await tmux.paneSize(target);
  } catch (err) {
    const msg =
      err instanceof AttachError || err instanceof CaptureError || err instanceof Error
        ? err.message
        : String(err);
    io.err(msg.startsWith('vibeshare') ? msg : `vibeshare attach: ${msg}`);
    return 2;
  }

  const sessionLabel = options.name ?? `tmux ${target}`;
  const minted = await mintShareRuntime(options, io, sessionLabel);
  if (!minted.ok) return minted.code;
  const { runtime } = minted;
  const { created } = runtime;

  io.out(
    `  source:   tmux ${target}` +
      (options.access === 'invite' ? ' (attach · viewers may request to drive)' : ' (attach · read-only)'),
  );

  let captureStop: (() => Promise<void>) | null = null;
  try {
    const source = createTmuxCaptureSource({
      target,
      tmux,
      ...(options.sizePollMs !== undefined ? { sizePollMs: options.sizePollMs } : {}),
    });
    const handle = await source.start(created.feed);
    captureStop = () => handle.stop();
    // Approved collaborator input → tmux send-keys -l (literal).
    if (handle.writeInput) {
      runtime.setInputSink((data) => {
        void handle.writeInput?.(data);
      });
    }
  } catch (err) {
    const msg = err instanceof AttachError || err instanceof Error ? err.message : String(err);
    io.err(msg.startsWith('vibeshare') ? msg : `vibeshare attach: ${msg}`);
    await runtime.cleanup();
    return 2;
  }

  // Host stays attached until SIGINT/SIGTERM / vibeshare stop. We do not proxy
  // host stdin into the pane (the user's own tmux client already owns input).
  let shuttingDown = false;
  const exitCode = await new Promise<number>((resolve) => {
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));

    function shutdown(code: number): void {
      if (shuttingDown) return;
      shuttingDown = true;
      resolve(code);
    }
    shutdownRef = shutdown;
  });

  if (captureStop) {
    try { await captureStop(); } catch { /* best effort */ }
  }
  await runtime.cleanup();
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

  // --public shares expose a loopback HostControlServer (port + hostToken in
  // the active-share record) so approve/deny/kick work the same as local-http.
  if (record.transport === 'webrtc' && (!record.port || !record.hostToken)) {
    io.err('vibeshare: this public share has no host control endpoint (upgrade the sharing process)');
    return 1;
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
  // Prefer loopback control (works for local-http, tunnel, and modern --public).
  // Fall back to SIGTERM for legacy public records with no control port.
  if (record.transport === 'webrtc' && (!record.port || !record.hostToken)) {
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
    case 'attach':
      return attachShare(command.options, io);
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
