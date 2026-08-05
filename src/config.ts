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
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const config: {
      signalingUrl?: string;
      tunnel?: TunnelConfig;
      iceServers?: readonly RTCIceServer[];
    } = {};
    if (typeof raw['signalingUrl'] === 'string' && raw['signalingUrl'].trim().length > 0) {
      config.signalingUrl = raw['signalingUrl'];
    }
    const tunnel = parseTunnelConfig(raw['tunnel']);
    if (tunnel) config.tunnel = tunnel;
    const iceServers = sanitizeIceServers(raw['iceServers']);
    if (iceServers) config.iceServers = iceServers;
    return config;
  } catch {
    return {};
  }
}

function parseTunnelConfig(raw: unknown): TunnelConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const out: {
    provider?: string;
    account?: TunnelAccountConfig;
    endpoint?: string;
    hostname?: string;
  } = {};
  if (typeof t['provider'] === 'string' && t['provider'].trim().length > 0) {
    out.provider = t['provider'].trim();
  }
  if (typeof t['endpoint'] === 'string' && t['endpoint'].trim().length > 0) {
    out.endpoint = t['endpoint'].trim();
  }
  if (typeof t['hostname'] === 'string' && t['hostname'].trim().length > 0) {
    out.hostname = t['hostname'].trim();
  }
  if (typeof t['account'] === 'object' && t['account'] !== null && !Array.isArray(t['account'])) {
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
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const urls = e['urls'];
    let cleanUrls: string | string[] | undefined;
    if (typeof urls === 'string' && urls.trim().length > 0) {
      cleanUrls = urls.trim();
    } else if (Array.isArray(urls)) {
      const list = urls
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map((u) => u.trim());
      if (list.length > 0) cleanUrls = list;
    }
    if (cleanUrls === undefined) continue;
    const server: { urls: string | string[]; username?: string; credential?: string } = { urls: cleanUrls };
    if (typeof e['username'] === 'string' && e['username'].length > 0) server.username = e['username'];
    if (typeof e['credential'] === 'string' && e['credential'].length > 0) server.credential = e['credential'];
    out.push(server);
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

  let provider: string | undefined;
  if (sources.flag === true || sources.flag === '') {
    provider = undefined; // explicit cascade
  } else if (typeof sources.flag === 'string' && sources.flag.trim().length > 0) {
    provider = sources.flag.trim();
  } else if (typeof sources.env === 'string' && sources.env.trim().length > 0) {
    provider = sources.env.trim();
  } else if (typeof fileTunnel?.provider === 'string' && fileTunnel.provider.trim().length > 0) {
    provider = fileTunnel.provider.trim();
  }

  const account = fileTunnel?.account;
  const startOpts: {
    hostname?: string;
    serverAddr?: string;
    env?: NodeJS.ProcessEnv;
  } = {};

  // hostname: file-level first, then per-provider account.
  const hostname =
    nonEmpty(fileTunnel?.hostname) ??
    nonEmpty(account?.cloudflared?.hostname) ??
    nonEmpty(account?.cloudflare?.hostname) ??
    nonEmpty(account?.tailscale?.hostname);
  if (hostname) startOpts.hostname = hostname;

  // frp / self-hosted server: env > file endpoint > account.frp > account.self-hosted
  const serverAddr =
    nonEmpty(env[FRP_SERVER_ADDR_ENV]) ??
    nonEmpty(fileTunnel?.endpoint) ??
    nonEmpty(account?.frp?.serverAddr) ??
    nonEmpty(account?.frp?.hostname) ??
    nonEmpty(account?.['self-hosted']?.serverAddr) ??
    nonEmpty(account?.['self-hosted']?.endpoint);
  if (serverAddr) startOpts.serverAddr = serverAddr;

  // ngrok authtoken: env > account.ngrok.authtoken|token
  const ngrokToken =
    nonEmpty(env[NGROK_AUTHTOKEN_ENV]) ??
    nonEmpty(account?.ngrok?.authtoken) ??
    nonEmpty(account?.ngrok?.token);
  if (ngrokToken) {
    startOpts.env = { NGROK_AUTHTOKEN: ngrokToken };
  }

  const resolved: ResolvedTunnel = { startOpts };
  if (provider !== undefined) (resolved as { provider: string }).provider = provider;
  // Only include startOpts keys that actually got set.
  const cleanOpts: TunnelStartOpts = {};
  if (startOpts.hostname !== undefined) (cleanOpts as { hostname: string }).hostname = startOpts.hostname;
  if (startOpts.serverAddr !== undefined) (cleanOpts as { serverAddr: string }).serverAddr = startOpts.serverAddr;
  if (startOpts.env !== undefined) (cleanOpts as { env: NodeJS.ProcessEnv }).env = startOpts.env;
  return { ...resolved, startOpts: cleanOpts };
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
