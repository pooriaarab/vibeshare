import {
  badge,
  createHookBus,
  watchCwd,
  type TriggerKind,
} from '@pooriaarab/vibe-core';
import { clearActiveShare, loadLedger, writeActiveShare, type ActiveShareRecord } from '../consent.js';
import { ConsentRequiredError, ShareManager, SHARE_SCOPE, type CreatedShare } from '../manager.js';
import type { ShareFlags } from './parse.js';
import { makePrinters } from './printers.js';
import type { IO } from './runtimeTypes.js';
import type { ShareRuntime } from './runtimeTypes.js';
import { setShutdownRef } from './shutdown.js';
import { buildTransport, handlePublicPostCreate, setupTunnelIfNeeded, TunnelSetupError } from './transportSetup.js';

const HOOK_KINDS: TriggerKind[] = [
  'task-done', 'pr-opened', 'prototype-finished', 'spec-completed',
  'tests-pass', 'tests-fail', 'error', 'session-end', 'manual',
];

async function ensureConsentChecked(io: IO, yes: boolean): Promise<boolean> {
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
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const { parseConfirm } = await import('@pooriaarab/vibe-core');
    const answer = await rl.question(`Share this session live by URL? Anyone with the link can view its output. (y/N) `);
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

function attachHooks(bus: ReturnType<typeof createHookBus>, created: CreatedShare): void {
  for (const kind of HOOK_KINDS) {
    bus.on(kind, (e) => { created.feed.publishEvent(e); });
  }
}

type RecordOpts = { created: CreatedShare; ctx: { localHttp: { port: number; hostToken: string } | null; hostControl: { port: number; hostToken: string } | null }; options: ShareFlags; tunnelOn: boolean };

function resolveTransportName(options: ShareFlags, tunnelOn: boolean): ActiveShareRecord['transport'] {
  if (options.public) return 'webrtc';
  if (tunnelOn) return 'tunnel';
  return 'local-http';
}

function buildRecord(opts: RecordOpts): ActiveShareRecord {
  const { created, ctx, options, tunnelOn } = opts;
  const port = ctx.localHttp?.port ?? ctx.hostControl?.port ?? 0;
  const hostToken = ctx.localHttp?.hostToken ?? ctx.hostControl?.hostToken ?? '';
  return {
    id: created.share.id,
    url: created.url,
    port,
    hostToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    transport: resolveTransportName(options, tunnelOn),
  };
}

type SummaryOpts = { created: CreatedShare; record: ActiveShareRecord; options: ShareFlags; tunnelOn: boolean; tunnelProviderName: string | null; io: IO };

function isLoopbackHost(options: ShareFlags, tunnelOn: boolean): boolean {
  if (options.public) return false;
  if (tunnelOn) return false;
  const h = options.host;
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function printModeLines(opts: SummaryOpts): void {
  const { created, options, tunnelOn, tunnelProviderName, io } = opts;
  if (created.share.passphraseHash) io.out(`  pass:     required`);
  if (options.public) io.out(`  mode:     public · end-to-end encrypted p2p (only the handshake crosses the rendezvous)`);
  if (tunnelOn && tunnelProviderName) {
    io.out(`  mode:     tunnel · end-to-end encrypted (provider: ${tunnelProviderName})`);
    io.out(`  provider: ${tunnelProviderName}`);
  }
}

function printShareSummary(opts: SummaryOpts): void {
  const { created, options, tunnelOn, io } = opts;
  const loopback = isLoopbackHost(options, tunnelOn);
  io.out(`${badge(loopback ? 'local' : 'p2p')}`);
  io.out(`  sharing:  ${created.share.name}`);
  io.out(`  url:      ${created.url}`);
  const accessNote = created.share.access === 'spectate' ? ' (read-only)' : ' (viewers may request to join)';
  io.out(`  access:   ${created.share.access}${accessNote}`);
  io.out(`  expires:  ${created.share.expiresAt ?? 'until you stop'}`);
  printModeLines(opts);
  io.out(`  manage:   vibeshare viewers · vibeshare stop`);
  const showNote = !loopback && !options.public && !tunnelOn;
  if (showNote) io.err('note: bound to a non-loopback address — anyone who can reach this host with the link can watch.');
}

async function tryCreateShare(
  manager: ShareManager,
  options: ShareFlags,
  sessionLabel: string | undefined,
): Promise<CreatedShare> {
  return manager.createShare({
    access: options.access,
    expiry: options.expiry,
    ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.feedCapacity !== undefined ? { feedCapacity: options.feedCapacity } : {}),
    session: sessionLabel,
  });
}

function validateExclusive(options: ShareFlags, io: IO): { ok: true } | { ok: false; code: number } {
  if (options.public && options.tunnel) {
    io.err('vibeshare: --public and --tunnel are mutually exclusive');
    return { ok: false, code: 2 };
  }
  return { ok: true };
}

type CreateShareOpts = {
  ctx: Awaited<ReturnType<typeof buildTransport>>;
  options: ShareFlags;
  sessionLabel: string | undefined;
  watcher: { stop(): void };
  io: IO;
  createdRef: { value: CreatedShare | null };
  printers: ReturnType<typeof makePrinters>;
};

async function createShareWithManager(
  opts: CreateShareOpts,
): Promise<{ ok: true; created: CreatedShare; manager: ShareManager } | { ok: false; code: number }> {
  const manager = new ShareManager({ consent: loadLedger(), transport: opts.ctx.transport });
  try {
    const created = await tryCreateShare(manager, opts.options, opts.sessionLabel);
    opts.createdRef.value = created;
    const isPublic = opts.options.public && opts.ctx.publicSignaling;
    if (isPublic) handlePublicPostCreate({ created, ctx: opts.ctx, printers: opts.printers });
    return { ok: true, created, manager };
  } catch (err) {
    opts.watcher.stop();
    await opts.ctx.transport.close();
    if (err instanceof ConsentRequiredError) {
      opts.io.err(`vibeshare: ${err.message}`);
      return { ok: false, code: 1 };
    }
    if (err instanceof Error) {
      opts.io.err(`vibeshare: ${err.message}`);
      return { ok: false, code: 2 };
    }
    throw err;
  }
}

function finalizeShare(opts: {
  bus: ReturnType<typeof createHookBus>;
  created: CreatedShare;
  ctx: Awaited<ReturnType<typeof buildTransport>>;
  options: ShareFlags;
  tunnelOn: boolean;
  tunnelProviderName: string | null;
  io: IO;
}): ActiveShareRecord {
  attachHooks(opts.bus, opts.created);
  const record = buildRecord({ created: opts.created, ctx: opts.ctx, options: opts.options, tunnelOn: opts.tunnelOn });
  writeActiveShare(record);
  printShareSummary({ created: opts.created, record, options: opts.options, tunnelOn: opts.tunnelOn, tunnelProviderName: opts.tunnelProviderName, io: opts.io });
  return record;
}

type PreparedCtx = {
  bus: ReturnType<typeof createHookBus>;
  watcher: ReturnType<typeof watchCwd>;
  printers: ReturnType<typeof makePrinters>;
  ctx: Awaited<ReturnType<typeof buildTransport>>;
  createdRef: { value: CreatedShare | null };
  publicShareKey: { value: Buffer | null };
};

async function prepareContext(opts: { options: ShareFlags; io: IO }): Promise<PreparedCtx> {
  const bus = createHookBus({ onError: (e) => opts.io.err(`[vibeshare] hook error: ${String(e)}`) });
  const watcher = watchCwd(process.cwd(), bus);
  const printers = makePrinters(opts.io);
  const createdRef: { value: CreatedShare | null } = { value: null };
  const publicShareKey: { value: Buffer | null } = { value: null };
  const ctx = await buildTransport({ options: opts.options, io: opts.io, printers, createdRef, publicShareKey });
  ctx.createdRef = createdRef;
  ctx.publicShareKey = publicShareKey;
  return { bus, watcher, printers, ctx, createdRef, publicShareKey };
}

type TunnelResult = { created: CreatedShare; tunnelHandle: { url: string; stop(): Promise<void> } | null; tunnelProviderName: string | null };

async function runTunnelPhase(opts: {
  ctx: Awaited<ReturnType<typeof buildTransport>>;
  options: ShareFlags;
  created: CreatedShare;
  watcher: { stop(): void };
  manager: ShareManager;
  io: IO;
  createdRef: { value: CreatedShare | null };
}): Promise<TunnelResult> {
  try {
    const res = await setupTunnelIfNeeded({ ctx: opts.ctx, options: opts.options, created: opts.created, watcher: opts.watcher, manager: opts.manager, io: opts.io });
    opts.createdRef.value = res.created;
    return res;
  } catch (err) {
    if (err instanceof TunnelSetupError) throw err;
    throw err;
  }
}


function buildRuntimeParts(opts: {
  created: CreatedShare;
  manager: ShareManager;
  record: ActiveShareRecord;
  watcher: ReturnType<typeof watchCwd>;
  ctx: Awaited<ReturnType<typeof buildTransport>>;
  tunnelHandle: { url: string; stop(): Promise<void> } | null;
  tunnelOn: boolean;
  tunnelProviderName: string | null;
  printers: ReturnType<typeof makePrinters>;
}): ShareRuntime {
  let cleaned = false;
  let handle = opts.tunnelHandle;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    opts.printers.setSink(null);
    opts.watcher.stop();
    clearActiveShare(opts.record.id);
    await opts.manager.stopAll();
    if (opts.ctx.hostControl) {
      try { await opts.ctx.hostControl.close(); } catch { /* best effort */ }
      opts.ctx.hostControl = null;
    }
    if (handle) {
      try { await handle.stop(); } catch { /* best effort */ }
      handle = null;
    }
  };
  return {
    created: opts.created,
    manager: opts.manager,
    record: opts.record,
    get tunnelHandle() { return handle; },
    watcher: opts.watcher,
    tunnelOn: opts.tunnelOn,
    tunnelProviderName: opts.tunnelProviderName,
    setInputSink(sink) { opts.printers.setSink(sink); },
    cleanup,
  };
}

export async function mintShareRuntime(
  options: ShareFlags,
  io: IO,
  sessionLabel: string | undefined,
): Promise<{ ok: true; runtime: ShareRuntime } | { ok: false; code: number }> {
  const exclusive = validateExclusive(options, io);
  if (!exclusive.ok) return exclusive;
  if (!(await ensureConsentChecked(io, options.yes))) return { ok: false, code: 1 };
  const prepared = await prepareContext({ options, io });
  const { bus, watcher, printers, ctx, createdRef } = prepared;
  const shareRes = await createShareWithManager({ ctx, options, sessionLabel, watcher, io, createdRef, printers });
  if (!shareRes.ok) return shareRes;
  let created = shareRes.created;
  const manager = shareRes.manager;
  const tunnelOn = options.tunnel !== false;
  let tunnelHandle: { url: string; stop(): Promise<void> } | null = null;
  let tunnelProviderName: string | null = null;
  try {
    const res = await runTunnelPhase({ ctx, options, created, watcher, manager, io, createdRef });
    created = res.created;
    tunnelHandle = res.tunnelHandle;
    tunnelProviderName = res.tunnelProviderName;
  } catch (err) {
    if (err instanceof TunnelSetupError) return { ok: false, code: 2 };
    throw err;
  }
  const record = finalizeShare({ bus, created, ctx, options, tunnelOn, tunnelProviderName, io });
  const runtime = buildRuntimeParts({ created, manager, record, watcher, ctx, tunnelHandle, tunnelOn, tunnelProviderName, printers });
  return { ok: true, runtime };
}

export { setShutdownRef };
