/**
 * Public surface for the pure TunnelProvider registry.
 *
 * CLI wiring lands later — this package island is intentionally self-contained.
 */
export type {
  CommandExistsFn,
  ProviderDeps,
  SpawnImpl,
  TunnelChildProcess,
  TunnelHandle,
  TunnelProvider,
  TunnelStartOpts,
} from './provider.js';

export { commandExists } from './detect.js';
export { DEFAULT_START_TIMEOUT_MS, startProcessTunnel } from './process.js';
export { createTunnelRegistry, TunnelRegistry } from './registry.js';

export {
  BORE_URL_RE,
  CLOUDFLARED_URL_RE,
  createBoreProvider,
  createCloudflaredProvider,
  createDefaultProviders,
  createFrpProvider,
  createGetvibeProvider,
  createLocalhostRunProvider,
  createLocaltunnelProvider,
  createNgrokProvider,
  createPinggyProvider,
  createServeoProvider,
  createTailscaleProvider,
  createTunnelmoleProvider,
  createZrokProvider,
  DEFAULT_PROVIDER_ORDER,
  FRP_URL_RE,
  GETVIBE_URL_RE,
  LOCALHOST_RUN_URL_RE,
  LOCALTUNNEL_URL_RE,
  NGROK_URL_RE,
  PINGGY_URL_RE,
  SERVEO_URL_RE,
  TAILSCALE_URL_RE,
  TUNNELMOLE_URL_RE,
  ZROK_URL_RE,
} from './providers/index.js';
export type { ProviderName } from './providers/index.js';
