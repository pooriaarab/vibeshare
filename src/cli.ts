#!/usr/bin/env node
/**
 * vibeshare CLI.
 *
 * Hosts a vibelive session and mints a shareable capability URL for it. The CLI
 * is the URL/access layer over vibelive's engine — it does not reimplement
 * transport. Prints the share URL, access mode, and the local-first badge, then
 * runs in the foreground with slash-command viewer management.
 *
 *   vibeshare [--spectate|--invite] [--expire 1h|24h] [--pass <p>] -- <command...>
 *   vibeshare host  [flags] -- <command...>   (same thing, explicit)
 *   vibeshare stop · vibeshare viewers · vibeshare mcp · --version · --help
 *
 * `parseArgs` is pure (no IO) and unit-tested in `src/cli.test.ts`; `main` is the
 * process entrypoint and returns an exit code without calling `process.exit`
 * itself (mirrors the vibelive CLI contract).
 */
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHost, createRelay, SHARE_SESSION_SCOPE } from 'vibelive';
import type { RelayHandle } from 'vibelive';
import { createShare } from './share.js';
import type { ExpirySpec } from './share.js';
import type { AccessMode } from './access.js';
import { VERSION } from './version.js';

const HOST_ID = 'host';
const BADGE = '\u25CF p2p \u00B7 e2e \u00B7 nothing stored on a server'; // ● p2p · e2e · …

type ParsedCommand =
  | { readonly cmd: 'help' }
  | { readonly cmd: 'version' }
  | { readonly cmd: 'mcp' }
  | { readonly cmd: 'stop' }
  | { readonly cmd: 'viewers' }
  | {
      readonly cmd: 'host';
      readonly command: readonly string[];
      readonly access: AccessMode;
      readonly expire?: ExpirySpec;
      readonly pass?: string;
      readonly name?: string;
    }
  | { readonly cmd: 'error'; readonly message: string };

const err = (message: string): ParsedCommand => ({ cmd: 'error', message });

/**
 * Parse vibeshare argv (`process.argv.slice(2)`). Pure — no IO.
 *
 * Everything after a bare `--` is the opaque wrapped command and is never scanned
 * for vibeshare flags, so `vibeshare -- claude --help` wraps `claude --help`
 * rather than printing vibeshare's own help. Both `vibeshare -- <cmd>` and the
 * explicit `vibeshare host -- <cmd>` forms are accepted.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const dd = argv.indexOf('--');
  const head = dd >= 0 ? argv.slice(0, dd) : [...argv];
  const command = dd >= 0 ? argv.slice(dd + 1) : [];

  if (head.includes('--help') || head.includes('-h')) return { cmd: 'help' };
  if (head.includes('--version') || head.includes('-v')) return { cmd: 'version' };

  const sub = head[0];

  if (sub === 'stop') return { cmd: 'stop' };
  if (sub === 'viewers') return { cmd: 'viewers' };
  if (sub === 'mcp') return { cmd: 'mcp' };

  // Bare `vibeshare` (or just `vibeshare --`) with nothing to do → show help.
  if (head.length === 0 && command.length === 0) return { cmd: 'help' };

  // host: explicit `host` subcommand, or implicit (empty head, or leading flags).
  let flagTokens: readonly string[];
  if (sub === 'host') {
    flagTokens = head.slice(1);
  } else if (sub === undefined || sub.startsWith('-')) {
    flagTokens = head;
  } else {
    return err(`unknown command: ${sub}`);
  }

  let access: AccessMode = 'spectate';
  let expire: ExpirySpec | undefined;
  let pass: string | undefined;
  let name: string | undefined;

  for (let i = 0; i < flagTokens.length; i++) {
    const t = flagTokens[i];
    if (t === undefined) break;
    const next = flagTokens[i + 1];
    if (t === '--spectate') {
      access = 'spectate';
    } else if (t === '--invite') {
      access = 'invite';
    } else if (t === '--expire') {
      if (next === undefined) return err('--expire requires a value (1h | 24h)');
      if (next !== '1h' && next !== '24h') {
        return err(`--expire must be "1h" or "24h", got: ${next}`);
      }
      expire = next;
      i++;
    } else if (t === '--pass') {
      if (next === undefined) return err('--pass requires a value');
      pass = next;
      i++;
    } else if (t === '--name') {
      if (next === undefined) return err('--name requires a value');
      name = next;
      i++;
    } else {
      return err(`unknown flag: ${t}`);
    }
  }

  if (command.length === 0) {
    return err('vibeshare needs a command after "--", e.g. `vibeshare --invite -- claude`');
  }

  return { cmd: 'host', command, access, expire, pass, name };
}

const HELP = `vibeshare ${VERSION} — share your live agent session by URL

USAGE
  vibeshare [--spectate|--invite] [--expire 1h|24h] [--pass <p>] -- <command...>
  vibeshare host   [the flags above]                -- <command...>
      Host a session running <command> (e.g. \`vibeshare --invite -- claude\`)
      and print its share URL. You start as the driver.

      --spectate   link holders get read-only access (default)
      --invite     link holders may request to join; approve to let them drive
      --expire     auto-revoke the share after 1h or 24h
      --pass <p>   require a passphrase on top of the share URL
      --name <s>   display name for the host participant

  vibeshare stop        stop the foreground host session (also: /stop inside it)
  vibeshare viewers     (in-foreground) list viewers / pending join requests
  vibeshare mcp         run the vibeshare MCP server on stdio
  vibeshare --version
  vibeshare --help

v0 is foreground, host-authoritative, local/LAN. The share URL points at your own
domain (vibeshare.stream); the live stream runs over a self-hostable e2e relay.
${BADGE}
`;

export function printHelp(stream: { write(s: string): boolean } = process.stdout): void {
  stream.write(HELP);
}

function lanAddress(): string | null {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      if (n && n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

interface HostRun {
  readonly command: readonly string[];
  readonly access: AccessMode;
  readonly expire?: ExpirySpec;
  readonly pass?: string;
  readonly name?: string;
}

async function runHost(p: HostRun): Promise<number> {
  const host = createHost({ command: p.command });
  const relay: RelayHandle = await createRelay({
    port: 0,
    hostHandle: host,
    initialDriver: HOST_ID,
    hostParticipantName: p.name ?? HOST_ID,
  });
  // Consent gates sharing session output off the host machine. vibelive's default
  // relay already grants this, but be explicit so a different consent setup still
  // works — and so createShare never trips its consent check.
  relay.consent.grant(SHARE_SESSION_SCOPE);

  let expired = false;
  const share = createShare({
    session: relay,
    access: p.access,
    expiry: p.expire,
    passphrase: p.pass,
    onRevoke: (reason) => {
      if (reason === 'expired') expired = true;
    },
  });

  host.onOutput((entry) => process.stdout.write(entry.text));

  const accessLabel =
    p.access +
    (p.pass ? ' \u00B7 passphrase' : '') +
    (p.expire ? ` \u00B7 expires ${p.expire}` : ' \u00B7 no expiry');
  process.stderr.write(`vibeshare \u2014 sharing ${p.command.join(' ')}\n`);
  process.stderr.write(`  share:  ${share.url}\n`);
  process.stderr.write(`  access: ${accessLabel}\n`);
  process.stderr.write(`  relay:  ${relay.url}\n`);
  const lan = lanAddress();
  if (lan) {
    process.stderr.write(`  lan:     ws://${lan}:${relay.port}\n`);
  }
  process.stderr.write(`  ${BADGE}\n`);
  process.stderr.write(
    `  you are the driver. /release to hand off, /drive to take back, /viewers, /approve <id>, /stop to end.\n`,
  );

  const rl = createInterface({ input: process.stdin, terminal: false });
  const printViewers = () => {
    const roster = share.viewers();
    if (roster.viewers.length === 0 && roster.pending.length === 0) {
      process.stderr.write('  (no viewers connected)\n');
      return;
    }
    for (const v of roster.viewers) {
      process.stderr.write(`  \u25CF ${v.name} [${v.role}]\n`);
    }
    for (const v of roster.pending) {
      process.stderr.write(`  \u2026 ${v.name} [wants to join \u2014 /approve ${v.id}]\n`);
    }
  };

  rl.on('line', (line) => {
    if (line === '/stop' || line === '/quit') {
      void shutdown(0);
      return;
    }
    if (line === '/viewers') {
      printViewers();
      return;
    }
    if (line.startsWith('/approve ')) {
      const id = line.slice('/approve '.length).trim();
      const ok = share.approve(id);
      process.stderr.write(ok ? `  promoted ${id}.\n` : `  can't promote ${id} (unknown / spectate-only).\n`);
      return;
    }
    if (line === '/release') {
      relay.localReleaseControl(HOST_ID);
      process.stderr.write('  control released.\n');
      return;
    }
    if (line === '/drive') {
      relay.localRequestControl(HOST_ID);
      process.stderr.write('  control requested.\n');
      return;
    }
    if (relay.arbiter.isDriver(HOST_ID)) {
      host.sendInput(`${line}\n`);
    } else {
      process.stderr.write('  (not the driver \u2014 /drive to take control)\n');
    }
  });
  rl.on('SIGINT', () => void shutdown(0));

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    host.kill();
    await share.revoke();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(130));
  process.on('SIGTERM', () => void shutdown(143));

  // Expiry auto-revokes the share (closes the relay). When that fires, end the host.
  if (p.expire !== undefined) {
    void promiseTrue((): boolean => share.revoked).then(async () => {
      if (expired) {
        process.stderr.write('  share expired \u2014 tearing down.\n');
        await shutdown(0);
      }
    });
  }

  const code = await host.exited;
  await shutdown(code ?? 0);
  return code ?? 0;
}

/** Resolve once `pred` is true (polled; used to bridge the expiry flag to async). */
function promiseTrue(pred: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) resolve();
      else setTimeout(tick, 250);
    };
    tick();
  });
}

async function runStop(): Promise<number> {
  process.stderr.write(
    'vibeshare runs the host in the foreground. To stop it, switch to that terminal and\n' +
      'press Ctrl+C (or type /stop). v0 does not yet daemonize or keep cross-process state.\n',
  );
  return 0;
}

async function runViewers(): Promise<number> {
  process.stderr.write(
    'vibeshare runs the host in the foreground. Inside that session, type /viewers to list\n' +
      'connected viewers and pending join requests, and /approve <id> to promote one.\n',
  );
  return 0;
}

/** CLI entrypoint. Returns the desired exit code (does not call exit itself). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.cmd) {
    case 'help':
      printHelp();
      return 0;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'mcp': {
      const { runMcpStdio } = await import('./mcp.js');
      await runMcpStdio();
      return 0;
    }
    case 'stop':
      return runStop();
    case 'viewers':
      return runViewers();
    case 'host':
      return runHost(parsed);
    case 'error':
      process.stderr.write(`vibeshare: ${parsed.message}\n`);
      printHelp(process.stderr);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
