/**
 * Concrete TunnelProvider factories.
 *
 * Cascade preference (see {@link createDefaultProviders}): native / always-on
 * first, then popular CLIs, then npx one-shots, then self-hosted, then
 * SSH-based slow-paths last.
 */
import type { ProviderDeps, TunnelProvider } from '../provider.js';
import { createBoreProvider } from './bore.js';
import { createCloudflaredProvider } from './cloudflared.js';
import { createFrpProvider } from './frp.js';
import { createGetvibeProvider } from './getvibe.js';
import { createLocalhostRunProvider } from './localhost_run.js';
import { createLocaltunnelProvider } from './localtunnel.js';
import { createNgrokProvider } from './ngrok.js';
import { createPinggyProvider } from './pinggy.js';
import { createServeoProvider } from './serveo.js';
import { createTailscaleProvider } from './tailscale.js';
import { createTunnelmoleProvider } from './tunnelmole.js';
import { createZrokProvider } from './zrok.js';

export { createBoreProvider } from './bore.js';
export { createCloudflaredProvider } from './cloudflared.js';
export { createFrpProvider } from './frp.js';
export { createGetvibeProvider } from './getvibe.js';
export { createLocalhostRunProvider } from './localhost_run.js';
export { createLocaltunnelProvider } from './localtunnel.js';
export { createNgrokProvider } from './ngrok.js';
export { createPinggyProvider } from './pinggy.js';
export { createServeoProvider } from './serveo.js';
export { createTailscaleProvider } from './tailscale.js';
export { createTunnelmoleProvider } from './tunnelmole.js';
export { createZrokProvider } from './zrok.js';

export { BORE_URL_RE } from './bore.js';
export { CLOUDFLARED_URL_RE } from './cloudflared.js';
export { FRP_URL_RE } from './frp.js';
export { GETVIBE_URL_RE } from './getvibe.js';
export { LOCALHOST_RUN_URL_RE } from './localhost_run.js';
export { LOCALTUNNEL_URL_RE } from './localtunnel.js';
export { NGROK_URL_RE } from './ngrok.js';
export { PINGGY_URL_RE } from './pinggy.js';
export { SERVEO_URL_RE } from './serveo.js';
export { TAILSCALE_URL_RE } from './tailscale.js';
export { TUNNELMOLE_URL_RE } from './tunnelmole.js';
export { ZROK_URL_RE } from './zrok.js';

/**
 * Default cascade order. getvibe is always detectable (placeholder), so a
 * production build that ships without the relay overrides deps/`detect` or
 * callers pass `--tunnel <name>` / `resolve(preferred)`.
 */
export const DEFAULT_PROVIDER_ORDER = [
  'getvibe',
  'cloudflared',
  'tailscale',
  'ngrok',
  'localtunnel',
  'tunnelmole',
  'bore',
  'zrok',
  'frp',
  'localhost_run',
  'serveo',
  'pinggy',
] as const;

export type ProviderName = (typeof DEFAULT_PROVIDER_ORDER)[number];

/** Build the stock set of providers, sharing one deps bag (spawn, detect, …). */
export function createDefaultProviders(deps: ProviderDeps = {}): TunnelProvider[] {
  // Order matches DEFAULT_PROVIDER_ORDER.
  return [
    createGetvibeProvider(deps),
    createCloudflaredProvider(deps),
    createTailscaleProvider(deps),
    createNgrokProvider(deps),
    createLocaltunnelProvider(deps),
    createTunnelmoleProvider(deps),
    createBoreProvider(deps),
    createZrokProvider(deps),
    createFrpProvider(deps),
    createLocalhostRunProvider(deps),
    createServeoProvider(deps),
    createPinggyProvider(deps),
  ];
}
