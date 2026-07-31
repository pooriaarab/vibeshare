/**
 * vibeshare — npm library surface.
 *
 * ```ts
 * import { createShare, grantConsent } from 'vibeshare';
 *
 * grantConsent('share this session from my app');   // once, recorded locally
 * const { url, feed, viewers, revoke } = await createShare({
 *   session: 'npm test',
 *   access: 'spectate',
 *   expiry: '1h',
 * });
 * feed.publish('tests starting…');
 * await revoke();
 * ```
 *
 * Consent is enforced by the vibe-core ledger: no `share:session` grant →
 * `createShare` throws `ConsentRequiredError`. The default transport serves
 * the spectator view + stream from this machine; the relay/p2p seam is the
 * `ShareTransport` interface (see transport.ts).
 */
import { type ConsentLedger } from '@pooriaarab/vibe-core';
import { loadLedger } from './consent.js';
import { LocalHttpTransport, type LocalHttpTransportOptions } from './localHttp.js';
import { ShareManager, SHARE_SCOPE, type CreatedShare } from './manager.js';
import type { CreateShareOptions } from './types.js';

export { FileConsentStore, loadLedger, vibeHome } from './consent.js';
export {
  DEFAULT_SIGNALING_URL,
  SIGNALING_ENV,
  TUNNEL_PROVIDER_ENV,
  NGROK_AUTHTOKEN_ENV,
  FRP_SERVER_ADDR_ENV,
  readConfigFile,
  resolveSignaling,
  resolveSignalingUrl,
  resolveTunnel,
  resolveTunnelConfig,
  type ResolvedTunnel,
  type SignalingSources,
  type TunnelAccountConfig,
  type TunnelConfig,
  type TunnelSources,
  type VibeShareConfig,
} from './config.js';
export { SessionFeed, type PublishOptions } from './feed.js';
export { LocalHttpTransport, type LocalHttpTransportOptions } from './localHttp.js';
export { ConsentRequiredError, ShareManager, SHARE_SCOPE, type CreatedShare, type ShareManagerDeps } from './manager.js';
export { ViewerRegistry } from './registry.js';
export { SPECTATOR_CSS, spectatorPage, type SpectatorPageOptions } from './spectatorPage.js';
export type { SignalingChannel, SignalingFrame, SignalingSide } from './webrtc/signaling.js';
export { LoopbackSignaling } from './webrtc/signaling.js';
export { decryptFrame, encryptFrame, E2E_KEY_LEN, E2E_NONCE_LEN, E2E_TAG_LEN } from './e2e.js';
export { WebRtcTransport, type ViewerInputFrame, type WebRtcTransportOptions } from './webrtc/transport.js';
export { viewerPage } from './webrtc/viewerPage.js';
export { WsSignaling, type WsSignalingOptions } from './webrtc/wsSignaling.js';
export type { ShareTransport } from './transport.js';
export {
  ShareError,
  type CreateShareOptions,
  type FeedEntry,
  type JoinRequestStatus,
  type Share,
  type ShareAccess,
  type ShareErrorCode,
  type ShareState,
  type Viewer,
  type ViewerRole,
} from './types.js';
export { hashPassphrase, newShareId, newToken, parseExpiry, verifyPassphrase } from './utils.js';
export {
  createTunnelRegistry,
  TunnelRegistry,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartOpts,
} from './tunnel/index.js';
export { VERSION } from './version.js';

let defaultManager: ShareManager | null = null;

function getDefaultManager(transportOpts?: LocalHttpTransportOptions): ShareManager {
  defaultManager ??= new ShareManager({
    consent: loadLedger(),
    transport: new LocalHttpTransport(transportOpts),
  });
  return defaultManager;
}

export interface CreateShareLibraryOptions extends CreateShareOptions {
  /** Serve on a specific consent ledger (default: ~/.vibeshare file ledger). */
  readonly consent?: ConsentLedger;
  /** Transport options for the default local transport (host, port, baseUrl). */
  readonly transport?: LocalHttpTransportOptions;
  /** Bring your own manager (tests, embedders) instead of the shared default. */
  readonly manager?: ShareManager;
}

/**
 * Create a share → `{share, url, feed, viewers, revoke}`.
 *
 * @throws ConsentRequiredError when the ledger has no `share:session` grant.
 */
export async function createShare(opts: CreateShareLibraryOptions = {}): Promise<CreatedShare> {
  const manager = opts.manager
    ?? (opts.consent ? new ShareManager({ consent: opts.consent, transport: new LocalHttpTransport(opts.transport) }) : getDefaultManager(opts.transport));
  const { consent: _c, transport: _t, manager: _m, ...shareOpts } = opts;
  return manager.createShare(shareOpts);
}

/** Grant the `share:session` scope on the host's local consent ledger. */
export function grantConsent(note?: string): void {
  loadLedger().grant(SHARE_SCOPE, note ?? 'granted via vibeshare library');
}

/** Revoke the `share:session` scope. */
export function revokeConsent(): void {
  loadLedger().revoke(SHARE_SCOPE);
}
