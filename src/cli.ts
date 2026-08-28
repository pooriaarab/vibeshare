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
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startMcp } from './mcp.js';
import { VERSION } from './version.js';
import type { CliCommand } from './cli/parse.js';
import { CliUsageError, parseArgv } from './cli/parse.js';
import type { IO } from './cli/runtimeTypes.js';
import { attachShare } from './cli/attachShare.js';
import { startShare } from './cli/startShare.js';
import { traceShare } from './cli/traceShare.js';
import { stopCommand, viewersCommand } from './cli/control.js';

export type { ShareFlags, StartOptions, AttachCliOptions, TraceCliOptions, CliCommand } from './cli/parse.js';
export { CliUsageError, parseArgv } from './cli/parse.js';
export type { SessionInputSink, IO } from './cli/runtimeTypes.js';

const USAGE = `vibeshare — share your live agent coding session by URL

usage:
  vibeshare [options] [-- <cmd…>]   start sharing any harness/shell (default: your shell)
  vibeshare attach [target] [opts]  share an already-running tmux pane (harness-agnostic)
  vibeshare trace [agent] [opts]    share an already-running harness transcript (read-only)
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
  --ice-servers <json>
                    STUN/TURN servers for --public as a JSON array, e.g.
                    '[{"urls":"turn:host:3478","username":"u","credential":"p"}]'
                    (also VIBESHARE_ICE_SERVERS or ~/.vibeshare/config.json
                    iceServers; default: Google STUN only)
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

trace:
  agent defaults to claude; --cwd selects the project directory (default: current directory).
  Transcript sharing is read-only and auto-redacts likely secrets on a best-effort basis.

local-first: the stream is served from this machine; nothing is stored on a
server. Consent scope "share:session" is recorded in ~/.vibeshare/consent.json.`;

const stdio: IO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

export async function runCommand(command: CliCommand, io: IO = stdio): Promise<number> {
  if (command.cmd === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (command.cmd === 'version') {
    io.out(`vibeshare ${VERSION}`);
    return 0;
  }
  if (command.cmd === 'mcp') {
    await startMcp();
    return 0;
  }
  if (command.cmd === 'start') return startShare(command.options, io);
  if (command.cmd === 'attach') return attachShare(command.options, io);
  if (command.cmd === 'trace') return traceShare(command.options, io);
  if (command.cmd === 'viewers') return viewersCommand(command, io);
  return stopCommand(command, io);
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
const argvEntry = process.argv[1];
const isMain = argvEntry !== undefined && import.meta.url === pathToFileURL(realpathSync(argvEntry)).href;
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('vibeshare:', err);
      process.exit(1);
    },
  );
}
