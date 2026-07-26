/**
 * @pooriaarab/vibeshare — share your live agent coding session by URL.
 *
 * vibeshare is the **URL / access / identity layer** on top of
 * [`@pooriaarab/vibelive`](https://www.npmjs.com/package/@pooriaarab/vibelive):
 * it mints a capability URL for a running vibelive session, sets an access policy
 * (spectate read-only ↔ invite to collaborate), optional expiry + passphrase, and
 * enforces that **spectators can never drive the wrapped agent**.
 *
 * The engine — transport, presence, ordered output fan-out, write-arbitration — is
 * vibelive's. vibeshare owns the link + the gate. See `docs/spec.md`.
 *
 * ```ts
 * import { createHost, createRelay } from '@pooriaarab/vibelive';
 * import { createShare } from '@pooriaarab/vibeshare';
 *
 * const host = createHost({ command: ['claude'] });
 * const relay = await createRelay({ port: 0, hostHandle: host, initialDriver: 'host' });
 * const share = createShare({ session: relay, access: 'spectate', expiry: '1h' });
 * console.log(share.url); // https://vibeshare.stream/s/<id>
 * ```
 */
export { VERSION } from './version.js';

// url layer
export {
  SHARE_ORIGIN,
  SHARE_PATH_PREFIX,
  ShareUrlParseError,
  buildShareUrl,
  newShareId,
  parseShareUrl,
} from './url.js';

// access gate
export {
  DEFAULT_ACCESS,
  createAccessGate,
} from './access.js';
export type {
  AccessGate,
  AccessGateOptions,
  AccessMode,
  ControlRequestResult,
  DenialReason,
  ViewerRole,
} from './access.js';

// share orchestrator
export {
  ConsentError,
  HOST_PARTICIPANT_NAME,
  SHARE_SESSION_SCOPE,
  createShare,
  parseExpiry,
} from './share.js';
export type {
  ExpirySpec,
  RevokeReason,
  ShareHandle,
  ShareOptions,
  Viewer,
  ViewerRoster,
} from './share.js';
