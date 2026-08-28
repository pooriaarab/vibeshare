import type { TmuxClient } from '../attach.js';
import type { TranscriptAgent } from '../transcript/types.js';

export interface ShareFlags {
  access: 'spectate' | 'invite';
  expiry: string;
  passphrase?: string;
  port: number;
  host: string;
  name?: string;
  yes: boolean;
  public: boolean;
  tunnel: boolean | string;
  signaling?: string;
  iceServers?: string;
  feedCapacity?: number;
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
  target?: string;
  tmux?: TmuxClient;
  sizePollMs?: number;
}

export interface TraceCliOptions extends ShareFlags {
  agent: TranscriptAgent;
  cwd: string;
}

export type CliCommand =
  | { cmd: 'start'; options: StartOptions }
  | { cmd: 'attach'; options: AttachCliOptions }
  | { cmd: 'trace'; options: TraceCliOptions }
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

export class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

export function defaultShareFlags(): ShareFlags {
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

type FlagCtx = {
  opts: ShareFlags;
  args: string[];
  idx: { i: number };
};

function getNextValue(ctx: FlagCtx, flag: string): string {
  const nextIdx = ctx.idx.i + 1;
  const val = ctx.args[nextIdx];
  if (val === undefined) throw new CliUsageError(`${flag} needs a value`);
  ctx.idx.i = nextIdx;
  return val;
}

function handleTunnel(ctx: FlagCtx): void {
  const next = ctx.args[ctx.idx.i + 1];
  const isProvider = next !== undefined && !next.startsWith('-') && next !== '--';
  if (isProvider) {
    ctx.idx.i += 1;
    const val = ctx.args[ctx.idx.i];
    if (val === undefined) throw new CliUsageError('--tunnel needs a value');
    ctx.opts.tunnel = val;
  } else {
    ctx.opts.tunnel = true;
  }
}

function handlePort(ctx: FlagCtx): void {
  const raw = getNextValue(ctx, '--port');
  const n = Number(raw);
  const valid = Number.isInteger(n) && n >= 0 && n <= 65535;
  if (!valid) throw new CliUsageError('--port must be 0–65535');
  ctx.opts.port = n;
}

const SHARE_FLAG_TABLE: Record<string, (ctx: FlagCtx) => void> = {
  '--spectate': (ctx) => { ctx.opts.access = 'spectate'; },
  '--invite': (ctx) => { ctx.opts.access = 'invite'; },
  '--public': (ctx) => { ctx.opts.public = true; },
  '--tunnel': handleTunnel,
  '--signaling': (ctx) => { ctx.opts.signaling = getNextValue(ctx, '--signaling'); },
  '--ice-servers': (ctx) => { ctx.opts.iceServers = getNextValue(ctx, '--ice-servers'); },
  '--expire': (ctx) => { ctx.opts.expiry = getNextValue(ctx, '--expire'); },
  '--expiry': (ctx) => { ctx.opts.expiry = getNextValue(ctx, '--expiry'); },
  '--pass': (ctx) => { ctx.opts.passphrase = getNextValue(ctx, '--pass'); },
  '--port': handlePort,
  '--host': (ctx) => { ctx.opts.host = getNextValue(ctx, '--host'); },
  '--name': (ctx) => { ctx.opts.name = getNextValue(ctx, '--name'); },
  '--yes': (ctx) => { ctx.opts.yes = true; },
  '-y': (ctx) => { ctx.opts.yes = true; },
  '--help': () => { throw new HelpRequested(); },
  '-h': () => { throw new HelpRequested(); },
};

export function parseShareFlags(
  args: string[],
  opts: ShareFlags,
): { positionals: string[]; commandAfterDashDash: string[] | null } {
  const positionals: string[] = [];
  let commandAfterDashDash: string[] | null = null;
  const idx = { i: 0 };
  while (idx.i < args.length) {
    const raw = args[idx.i];
    if (raw === undefined) break;
    if (raw === '--') {
      commandAfterDashDash = args.slice(idx.i + 1);
      break;
    }
    const fn = Object.hasOwn(SHARE_FLAG_TABLE, raw) ? SHARE_FLAG_TABLE[raw] : undefined;
    if (fn) {
      fn({ opts, args, idx });
    } else if (raw.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${raw}`);
    } else {
      positionals.push(raw);
    }
    idx.i += 1;
  }
  return { positionals, commandAfterDashDash };
}

function extractCwd(args: string[]): { shareArgs: string[]; cwd: string } {
  const shareArgs: string[] = [];
  let cwd = process.cwd();
  const idx = { i: 0 };
  while (idx.i < args.length) {
    const arg = args[idx.i];
    if (arg === undefined) break;
    if (arg === '--cwd') {
      const nextIdx = idx.i + 1;
      const value = args[nextIdx];
      if (value === undefined) throw new CliUsageError('--cwd needs a value');
      if (value.startsWith('-')) throw new CliUsageError('--cwd needs a value');
      cwd = value;
      idx.i += 1;
    } else {
      shareArgs.push(arg);
    }
    idx.i += 1;
  }
  return { shareArgs, cwd };
}

export function parseTraceArgs(
  args: string[],
  flags: ShareFlags,
): { agent: TranscriptAgent; cwd: string } {
  const { shareArgs, cwd } = extractCwd(args);
  const { positionals, commandAfterDashDash } = parseShareFlags(shareArgs, flags);
  if (commandAfterDashDash !== null) throw new CliUsageError('trace does not take a command after `--`');
  if (positionals.length > 1) throw new CliUsageError('trace takes at most one agent (claude or codex)');
  const first = positionals[0];
  const rawAgent = first ?? 'claude';
  if (rawAgent !== 'claude' && rawAgent !== 'codex') throw new CliUsageError(`unsupported trace agent: ${rawAgent}`);
  return { agent: rawAgent, cwd };
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) throw new CliUsageError(`unknown option: ${a}`);
    out.push(a);
  }
  return out;
}

type ViewersOut = { cmd: 'viewers'; share?: string; approve?: string; deny?: string; kick?: string; json: boolean };

const VIEWER_ACTION_SET: Record<string, true> = { '--approve': true, '--deny': true, '--kick': true };

type ViewerFlagOpts = { out: ViewersOut; flag: string; args: string[]; idx: { i: number }; actions: { count: number } };

function applyViewerFlag(opts: ViewerFlagOpts): void {
  const nextIdx = opts.idx.i + 1;
  const id = opts.args[nextIdx];
  if (id === undefined) throw new CliUsageError(`${opts.flag} needs a viewer id`);
  const key = opts.flag.slice(2) as 'approve' | 'deny' | 'kick';
  opts.out[key] = id;
  opts.actions.count += 1;
  opts.idx.i += 1;
}

function parseViewersArgs(args: string[]): ViewersOut {
  const out: ViewersOut = { cmd: 'viewers', json: false };
  const actions = { count: 0 };
  const idx = { i: 0 };
  while (idx.i < args.length) {
    const a = args[idx.i];
    if (a === undefined) break;
    if (a === '--json') {
      out.json = true;
    } else if (Object.hasOwn(VIEWER_ACTION_SET, a)) {
      const fn = VIEWER_ACTION_SET[a];
      if (fn) applyViewerFlag({ out, flag: a, args, idx, actions });
    } else if (a.startsWith('-')) {
      throw new CliUsageError(`unknown option for viewers: ${a}`);
    } else if (out.share === undefined) {
      out.share = a;
    } else {
      throw new CliUsageError(`unexpected argument: ${a}`);
    }
    idx.i += 1;
  }
  if (actions.count > 1) throw new CliUsageError('use only one of --approve / --deny / --kick');
  return out;
}

function parseStopArgs(rest: string[]): { cmd: 'stop'; share?: string } {
  const extra = positionalArgs(rest.slice(1));
  if (extra.length > 1) throw new CliUsageError('stop takes at most one share id');
  const first = extra[0];
  if (first !== undefined) return { cmd: 'stop', share: first };
  return { cmd: 'stop' };
}

function parseAttachArgs(rest: string[]): CliCommand {
  const flags = defaultShareFlags();
  try {
    const { positionals, commandAfterDashDash } = parseShareFlags(rest.slice(1), flags);
    if (commandAfterDashDash !== null) {
      throw new CliUsageError('attach does not take `-- <cmd>` — pass a tmux target, or use `vibeshare -- <cmd>` to launch wrapped');
    }
    if (positionals.length > 1) throw new CliUsageError('attach takes at most one target (session:window.pane)');
    const first = positionals[0];
    const options: AttachCliOptions = {
      ...flags,
      ...(first !== undefined ? { target: first } : {}),
    };
    return { cmd: 'attach', options };
  } catch (err) {
    if (err instanceof HelpRequested) return { cmd: 'help' };
    throw err;
  }
}

function parseTraceCommand(rest: string[]): CliCommand {
  const flags = defaultShareFlags();
  try {
    const { agent, cwd } = parseTraceArgs(rest.slice(1), flags);
    return { cmd: 'trace', options: { ...flags, agent, cwd } };
  } catch (err) {
    if (err instanceof HelpRequested) return { cmd: 'help' };
    throw err;
  }
}

function parseStartArgs(rest: string[]): CliCommand {
  const options: StartOptions = { ...defaultShareFlags(), command: [] };
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

const HELP_SET = new Set(['--help', '-h', 'help']);
const VERSION_SET = new Set(['--version', '-v', 'version']);

const SUBCOMMAND_PARSERS: Record<string, (rest: string[]) => CliCommand> = {
  stop: (rest) => parseStopArgs(rest),
  viewers: (rest) => parseViewersArgs(rest.slice(1)),
  mcp: () => ({ cmd: 'mcp' }),
  attach: (rest) => parseAttachArgs(rest),
  trace: (rest) => parseTraceCommand(rest),
};

export function parseArgv(argv: string[]): CliCommand {
  const rest = [...argv];
  const sub = rest[0] ?? '';
  if (HELP_SET.has(sub)) return { cmd: 'help' };
  if (VERSION_SET.has(sub)) return { cmd: 'version' };
  const parser = Object.hasOwn(SUBCOMMAND_PARSERS, sub) ? SUBCOMMAND_PARSERS[sub] : undefined;
  if (parser) return parser(rest);
  if (sub === 'start') rest.shift();
  return parseStartArgs(rest);
}
