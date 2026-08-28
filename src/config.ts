/**
 * vibeshare infra config — local-first, bring-your-own.
 *
 * The getvibe.dev signaling Worker is the DEFAULT rendezvous for
 * `vibeshare --public`, but nothing here is locked to our infra: a user can
 * point `--public` at their own Cloudflare Worker or self-hosted signaling
 * server without touching ours. Precedence, highest first:
 *
 *   --signaling <url>  (CLI flag)
 *   VIBESHARE_SIGNALING  (environment)
 *   ~/.vibeshare/config.json  →  { "signalingUrl": "…" }
 *   built-in default  (getvibe.dev)
 *
 * Tunnel-provider settings live in the same file under `tunnel` (see
 * {@link TunnelConfig}). Secrets (e.g. an ngrok authtoken) live in this
 * file only and are never logged.
 *
 * ICE servers for `--public` (STUN/TURN) follow the same cascade:
 *
 *   --ice-servers '<json>'  (CLI flag)
 *   VIBESHARE_ICE_SERVERS   (environment)
 *   ~/.vibeshare/config.json  →  { "iceServers": [ … ] }
 *   built-in default  (Google STUN only)
 *
 * TURN entries carry the host's own credentials (see {@link RTCIceServer});
 * they are relayed to viewers over signaling so BYO TURN just works.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vibeHome } from './consent.js';
import type { TunnelStartOpts } from '@pooriaarab/vibe-core';

/** Default rendezvous: the getvibe.dev signaling Worker (ws base URL). */
export const DEFAULT_SIGNALING_URL = 'wss://getvibe.dev/vibeshare';

/** Env var that overrides the signaling endpoint (below the CLI flag). */
export const SIGNALING_ENV = 'VIBESHARE_SIGNALING';

/** Env var that pins the tunnel provider (below the CLI `--tunnel` flag). */
export const TUNNEL_PROVIDER_ENV = 'VIBESHARE_TUNNEL';

/** Env var carrying an ngrok authtoken (below config-file account.ngrok.authtoken). */
export const NGROK_AUTHTOKEN_ENV = 'NGROK_AUTHTOKEN';

/** Env var for a self-hosted frp server address. */
export const FRP_SERVER_ADDR_ENV = 'FRP_SERVER_ADDR';

/** Env var carrying the ICE server list as a JSON array (below the CLI flag). */
export const ICE_SERVERS_ENV = 'VIBESHARE_ICE_SERVERS';

/**
 * One STUN/TURN server entry — the browser `RTCIceServer` shape. The same
 * list drives the host's peer connections (mapped to node-datachannel's
 * string form, see src/webrtc/transport.ts) and is relayed verbatim to
 * browser viewers, so a TURN config here applies to BOTH ends.
 */
export interface RTCIceServer {
  /** e.g. `'stun:stun.l.google.com:19302'` or `'turn:turn.example.com:3478'`. */
  readonly urls: string | string[];
  /** TURN username (meaningless on STUN entries). */
  readonly username?: string;
  /** TURN credential / password — the host's own; treat as a secret. */
  readonly credential?: string;
}

/**
 * Default ICE config for `--public` when nothing is configured: free Google
 * STUN only — no TURN, no infra. Direct P2P works across most NATs with STUN
 * alone; symmetric NAT / isolated networks need a configured TURN server.
 */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Per-provider account material under `tunnel.account` in config.json.
 * All fields optional; only the provider in use is read. Never logged.
 */
export interface TunnelAccountConfig {
  /** ngrok: `{ "authtoken": "…" }` (also accepted as `token`). */
  readonly ngrok?: { readonly authtoken?: string; readonly token?: string };
  /** tailscale: optional funnel hostname / tailnet tag. */
  readonly tailscale?: { readonly hostname?: string };
  /** cloudflared named tunnel hostname. */
  readonly cloudflare?: { readonly hostname?: string };
  /** cloudflared alias (same keys as cloudflare). */
  readonly cloudflared?: { readonly hostname?: string };
  /** self-hosted / frp server address (`host` or `host:port`). */
  readonly frp?: { readonly serverAddr?: string; readonly hostname?: string };
  /** self-hosted alias for frp. */
  readonly ['self-hosted']?: { readonly serverAddr?: string; readonly endpoint?: string };
  /** Catch-all so unknown provider keys pass through without validation. */
  readonly [provider: string]: Record<string, string> | undefined;
}

/**
 * Tunnel settings from `~/.vibeshare/config.json` (and env). All fields
 * optional — missing config falls through to the detect-cascade.
 */
export interface TunnelConfig {
  /** Preferred provider name (default = cascade via TunnelRegistry.resolve()). */
  readonly provider?: string;
  /** Per-provider account material, keyed by provider name. Never logged. */
  readonly account?: TunnelAccountConfig;
  /**
   * Self-hosted endpoint override (e.g. frp server addr). Also accepted as
   * `account.frp.serverAddr` / `FRP_SERVER_ADDR`.
   */
  readonly endpoint?: string;
  /** Preferred public hostname for named tunnels (cloudflared / tailscale). */
  readonly hostname?: string;
}

/** The parsed contents of `~/.vibeshare/config.json` (all fields optional). */
export interface VibeShareConfig {
  /** Signaling rendezvous base ws URL for `--public` (default getvibe.dev). */
  readonly signalingUrl?: string;
  /** Tunnel provider settings for `vibeshare --tunnel`. */
  readonly tunnel?: TunnelConfig;
  /**
   * STUN/TURN servers for `--public` shares (see {@link resolveIceServers}).
   * TURN entries carry the host's own credentials — this file may hold
   * secrets and is never logged.
   */
  readonly iceServers?: readonly RTCIceServer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parseRawConfig(file: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) return null;
  return parsed;
}

function buildConfig(raw: Record<string, unknown>): VibeShareConfig {
  const config: {
    signalingUrl?: string;
    tunnel?: TunnelConfig;
    iceServers?: readonly RTCIceServer[];
  } = {};
  // Guard on the trimmed value but store the raw string: the original did
  // exactly this, and trimming here would change the resolved endpoint.
  const rawSignaling = raw['signalingUrl'];
  if (typeof rawSignaling === 'string' && rawSignaling.trim().length > 0) {
    config.signalingUrl = rawSignaling;
  }
  const tunnel = parseTunnelConfig(raw['tunnel']);
  if (tunnel !== undefined) config.tunnel = tunnel;
  const iceServers = sanitizeIceServers(raw['iceServers']);
  if (iceServers !== undefined) config.iceServers = iceServers;
  return config;
}

/**
 * Read `~/.vibeshare/config.json` (or `file`), tolerating everything: a
 * missing file, invalid JSON, or wrong-typed fields all yield `{}` rather
 * than throwing — a broken config must never block `vibeshare` from starting
 * with built-in defaults. Unknown fields are ignored; nothing here is logged
 * (the file may carry secrets).
 */
export function readConfigFile(file = join(vibeHome(), 'config.json')): VibeShareConfig {
  try {
    if (!existsSync(file)) return {};
    const raw = parseRawConfig(file);
    if (raw === null) return {};
    return buildConfig(raw);
  } catch {
    return {};
  }
}

function assignTrimmed(
  out: { provider?: string; endpoint?: string; hostname?: string },
  key: 'provider' | 'endpoint' | 'hostname',
  value: unknown,
): void {
  const v = trimmedString(value);
  if (v !== undefined) out[key] = v;
}

function parseTunnelConfig(raw: unknown): TunnelConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const out: {
    provider?: string;
    account?: TunnelAccountConfig;
    endpoint?: string;
    hostname?: string;
  } = {};
  assignTrimmed(out, 'provider', t['provider']);
  assignTrimmed(out, 'endpoint', t['endpoint']);
  assignTrimmed(out, 'hostname', t['hostname']);
  if (isRecord(t['account'])) {
    // Passed through as a string→string map bag; providers pull what they need.
    out.account = t['account'] as TunnelAccountConfig;
  }
  return Object.keys(out).length > 0 ? out : {};
}

/** The sources {@link resolveSignalingUrl} consults, in precedence order. */
export interface SignalingSources {
  /** `--signaling <url>` CLI flag. */
  readonly flag?: string | undefined;
  /** `VIBESHARE_SIGNALING` env var. */
  readonly env?: string | undefined;
  /** Parsed config file (see {@link readConfigFile}). */
  readonly file?: VibeShareConfig | undefined;
}

/**
 * Resolve the signaling endpoint for `vibeshare --public`:
 * flag > env > config file > built-in getvibe.dev default. Blank values are
 * treated as unset so an empty env var can't shadow the config file. Pure.
 */
export function resolveSignalingUrl(sources: SignalingSources): string {
  for (const candidate of [sources.flag, sources.env, sources.file?.signalingUrl]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return DEFAULT_SIGNALING_URL;
}

/** Convenience for the CLI: resolve from real flag/env/config-file inputs. */
export function resolveSignaling(flag?: string): string {
  return resolveSignalingUrl({ flag, env: process.env[SIGNALING_ENV], file: readConfigFile() });
}

function extractUrls(value: unknown): string | string[] | undefined {
  const single = trimmedString(value);
  if (single !== undefined) return single;
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    .map((u) => u.trim());
  if (list.length > 0) return list;
  return undefined;
}

function nonEmptyStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function toCleanIceServer(entry: unknown): RTCIceServer | undefined {
  if (!isRecord(entry)) return undefined;
  const e = entry;
  const cleanUrls = extractUrls(e['urls']);
  if (cleanUrls === undefined) return undefined;
  const server: { urls: string | string[]; username?: string; credential?: string } = { urls: cleanUrls };
  const username = nonEmptyStringField(e['username']);
  if (username !== undefined) server.username = username;
  const credential = nonEmptyStringField(e['credential']);
  if (credential !== undefined) server.credential = credential;
  return server;
}

/**
 * Coerce an unknown value into a clean RTCIceServer list. Entries without a
 * usable `urls` are dropped; `username`/`credential` pass through only as
 * non-empty strings. Returns undefined when nothing valid survives, so a
 * present-but-garbage value is treated as unset.
 */
export function sanitizeIceServers(raw: unknown): RTCIceServer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];
  for (const entry of raw) {
    const server = toCleanIceServer(entry);
    if (server !== undefined) out.push(server);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the `--ice-servers` flag / `VIBESHARE_ICE_SERVERS` env value: a JSON
 * array of RTCIceServer objects. Returns null on malformed JSON or when no
 * valid entry survives — the caller decides the fallback.
 */
export function parseIceServersJson(raw: string): RTCIceServer[] | null {
  try {
    return sanitizeIceServers(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

/** The sources {@link resolveIceServers} consults, in precedence order. */
export interface IceServersSources {
  /** `--ice-servers '<json>'` CLI flag (a JSON array of RTCIceServer objects). */
  readonly flag?: string | undefined;
  /** `VIBESHARE_ICE_SERVERS` env var (same JSON as the flag). */
  readonly env?: string | undefined;
  /** Parsed config file (see {@link readConfigFile}). */
  readonly file?: VibeShareConfig | undefined;
  /**
   * Called with a clear message when a flag/env value is present but
   * malformed; resolution then falls through to the next source.
   */
  readonly onError?: (message: string) => void;
}

/**
 * Resolve the ICE server list for `vibeshare --public`:
 * `--ice-servers` flag > VIBESHARE_ICE_SERVERS env > config file
 * `"iceServers"` key > default Google STUN. Blank values are treated as
 * unset; malformed flag/env JSON is reported via onError and skipped, so a
 * typo can never wedge the share — it falls back to the next source (and
 * ultimately to STUN-only, today's behaviour). Pure w.r.t. the sources.
 */
export function resolveIceServers(sources: IceServersSources): readonly RTCIceServer[] {
  const jsonSources: ReadonlyArray<readonly [string, string | undefined]> = [
    ['--ice-servers', sources.flag],
    [ICE_SERVERS_ENV, sources.env],
  ];
  for (const [label, raw] of jsonSources) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const parsed = parseIceServersJson(raw);
    if (parsed) return parsed;
    sources.onError?.(
      `${label}: malformed ICE servers JSON — expected an array like ` +
        `[{"urls":"turn:host:3478","username":"user","credential":"pass"}]; ignoring it`,
    );
  }
  const fromFile = sources.file?.iceServers;
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  return DEFAULT_ICE_SERVERS;
}

/** Convenience for the CLI: resolve from real flag/env/config-file inputs. */
export function resolveIceServersConfig(
  flag?: string,
  onError?: (message: string) => void,
): readonly RTCIceServer[] {
  return resolveIceServers({ flag, env: process.env[ICE_SERVERS_ENV], file: readConfigFile(), onError });
}

/** Sources {@link resolveTunnelConfig} consults, in precedence order. */
export interface TunnelSources {
  /**
   * `--tunnel` / `--tunnel <name>` CLI flag.
   * - `true` / `''`  → cascade (no preferred name)
   * - `'ngrok'`      → that provider
   * - `undefined`    → tunnel mode off (caller decides)
   */
  readonly flag?: string | true | undefined;
  /** `VIBESHARE_TUNNEL` env var (provider name). */
  readonly env?: string | undefined;
  /** Parsed config file. */
  readonly file?: VibeShareConfig | undefined;
  /** Live process env (for NGROK_AUTHTOKEN / FRP_SERVER_ADDR). Defaults to process.env. */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
}

/** Resolved tunnel knobs ready to go on a provider.start() call. */
export interface ResolvedTunnel {
  /**
   * Preferred provider name, or `undefined` to run the detect-cascade.
   * Present only when flag/env/file pinned one.
   */
  readonly provider?: string;
  /** Options passed straight into `provider.start(port, opts)`. */
  readonly startOpts: TunnelStartOpts;
}

function resolveTunnelProvider(sources: TunnelSources, fileTunnel: TunnelConfig | undefined): string | undefined {
  if (sources.flag === true || sources.flag === '') return undefined; // explicit cascade
  const flagVal = trimmedString(sources.flag);
  if (flagVal !== undefined) return flagVal;
  const envVal = trimmedString(sources.env);
  if (envVal !== undefined) return envVal;
  const fileVal = trimmedString(fileTunnel?.provider);
  if (fileVal !== undefined) return fileVal;
  return undefined;
}

/** hostname: file-level first, then per-provider account. */
function resolveTunnelHostname(
  fileTunnel: TunnelConfig | undefined,
  account: TunnelAccountConfig | undefined,
): string | undefined {
  const candidates = [
    fileTunnel?.hostname,
    account?.cloudflared?.hostname,
    account?.cloudflare?.hostname,
    account?.tailscale?.hostname,
  ];
  for (const candidate of candidates) {
    const v = nonEmpty(candidate);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Server addresses declared under the account bag, in precedence order. */
function accountServerAddrs(account: TunnelAccountConfig | undefined): (string | undefined)[] {
  return [
    account?.frp?.serverAddr,
    account?.frp?.hostname,
    account?.['self-hosted']?.serverAddr,
    account?.['self-hosted']?.endpoint,
  ];
}

/** frp / self-hosted server: env > file endpoint > account.frp > account.self-hosted. */
function resolveTunnelServerAddr(
  env: NodeJS.ProcessEnv,
  fileTunnel: TunnelConfig | undefined,
  account: TunnelAccountConfig | undefined,
): string | undefined {
  const candidates = [env[FRP_SERVER_ADDR_ENV], fileTunnel?.endpoint, ...accountServerAddrs(account)];
  for (const candidate of candidates) {
    const v = nonEmpty(candidate);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** ngrok authtoken: env > account.ngrok.authtoken|token. */
function resolveTunnelNgrokToken(
  env: NodeJS.ProcessEnv,
  account: TunnelAccountConfig | undefined,
): string | undefined {
  const candidates = [env[NGROK_AUTHTOKEN_ENV], account?.ngrok?.authtoken, account?.ngrok?.token];
  for (const candidate of candidates) {
    const v = nonEmpty(candidate);
    if (v !== undefined) return v;
  }
  return undefined;
}

function collectRawStartOpts(
  fileTunnel: TunnelConfig | undefined,
  account: TunnelAccountConfig | undefined,
  env: NodeJS.ProcessEnv,
): { hostname?: string; serverAddr?: string; env?: NodeJS.ProcessEnv } {
  const startOpts: { hostname?: string; serverAddr?: string; env?: NodeJS.ProcessEnv } = {};
  const hostname = resolveTunnelHostname(fileTunnel, account);
  if (hostname !== undefined) startOpts.hostname = hostname;
  const serverAddr = resolveTunnelServerAddr(env, fileTunnel, account);
  if (serverAddr !== undefined) startOpts.serverAddr = serverAddr;
  const ngrokToken = resolveTunnelNgrokToken(env, account);
  if (ngrokToken !== undefined) startOpts.env = { NGROK_AUTHTOKEN: ngrokToken };
  return startOpts;
}

/** Only include startOpts keys that actually got set. */
function cleanStartOpts(raw: { hostname?: string; serverAddr?: string; env?: NodeJS.ProcessEnv }): TunnelStartOpts {
  const cleanOpts: TunnelStartOpts = {};
  if (raw.hostname !== undefined) (cleanOpts as { hostname: string }).hostname = raw.hostname;
  if (raw.serverAddr !== undefined) (cleanOpts as { serverAddr: string }).serverAddr = raw.serverAddr;
  if (raw.env !== undefined) (cleanOpts as { env: NodeJS.ProcessEnv }).env = raw.env;
  return cleanOpts;
}

/**
 * Resolve tunnel provider + start opts from flag > env > file > defaults.
 * Pure w.r.t. the sources object — secrets in `startOpts.env` are never
 * stringified by this function.
 *
 * Precedence for the provider name: CLI flag > VIBESHARE_TUNNEL > config
 * `tunnel.provider` > cascade (undefined).
 *
 * Account material (authtoken, frp server, hostname) lands in startOpts so
 * providers can pick it up without reading the config file themselves.
 */
export function resolveTunnelConfig(sources: TunnelSources): ResolvedTunnel {
  const env = sources.processEnv ?? process.env;
  const fileTunnel = sources.file?.tunnel;
  const account = fileTunnel?.account;
  const provider = resolveTunnelProvider(sources, fileTunnel);
  const rawOpts = collectRawStartOpts(fileTunnel, account, env);
  const cleanOpts = cleanStartOpts(rawOpts);
  // Build startOpts-first, then attach provider, so the key order on the
  // returned object matches what callers serialized before.
  const resolved: ResolvedTunnel = { startOpts: cleanOpts };
  if (provider !== undefined) (resolved as { provider: string }).provider = provider;
  return resolved;
}

/** Convenience for the CLI: resolve from real flag/env/config-file inputs. */
export function resolveTunnel(flag?: string | true): ResolvedTunnel {
  return resolveTunnelConfig({
    flag,
    env: process.env[TUNNEL_PROVIDER_ENV],
    file: readConfigFile(),
    processEnv: process.env,
  });
}

function nonEmpty(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}
