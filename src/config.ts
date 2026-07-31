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
 * The config file is designed to grow: slice 3's tunnel-provider settings
 * drop into the same file under `tunnel` (see {@link TunnelConfig}) without
 * changing anything here. Secrets (e.g. an ngrok authtoken) live in this
 * file only and are never logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vibeHome } from './consent.js';

/** Default rendezvous: the getvibe.dev signaling Worker (ws base URL). */
export const DEFAULT_SIGNALING_URL = 'wss://getvibe.dev/vibeshare';

/** Env var that overrides the signaling endpoint (below the CLI flag). */
export const SIGNALING_ENV = 'VIBESHARE_SIGNALING';

/**
 * Slice-3 placeholder — NOT implemented yet. Documents the shape the tunnel
 * provider registry will read from the same config file: which provider
 * carries the viewer page/signaling when the host is behind NAT, plus the
 * per-provider account material (cloudflare credentials, an ngrok
 * `authtoken`, a tailscale tailnet, or a fully self-hosted endpoint).
 */
export interface TunnelConfig {
  readonly provider?: 'cloudflare' | 'ngrok' | 'tailscale' | 'self-hosted';
  /** Per-provider account material, keyed by provider (e.g. `{ ngrok: { authtoken } }`). */
  readonly account?: Record<string, Record<string, string>>;
  /** Self-hosted endpoint override (provider: "self-hosted"). */
  readonly endpoint?: string;
}

/** The parsed contents of `~/.vibeshare/config.json` (all fields optional). */
export interface VibeShareConfig {
  /** Signaling rendezvous base ws URL for `--public` (default getvibe.dev). */
  readonly signalingUrl?: string;
  /** Reserved for slice 3 — see {@link TunnelConfig}. Unimplemented. */
  readonly tunnel?: TunnelConfig;
}

/**
 * Read `~/.vibeshare/config.json` (or `file`), tolerating everything: a
 * missing file, invalid JSON, or wrong-typed fields all yield `{}` rather
 * than throwing — a broken config must never block `vibeshare` from starting
 * with built-in defaults. Unknown fields are ignored; nothing here is logged
 * (the file may carry slice-3 secrets).
 */
export function readConfigFile(file = join(vibeHome(), 'config.json')): VibeShareConfig {
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const config: { signalingUrl?: string; tunnel?: TunnelConfig } = {};
    if (typeof raw['signalingUrl'] === 'string' && raw['signalingUrl'].trim().length > 0) {
      config.signalingUrl = raw['signalingUrl'];
    }
    if (typeof raw['tunnel'] === 'object' && raw['tunnel'] !== null && !Array.isArray(raw['tunnel'])) {
      // Passed through verbatim — slice 3 owns validation of the shape.
      config.tunnel = raw['tunnel'] as TunnelConfig;
    }
    return config;
  } catch {
    return {};
  }
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
