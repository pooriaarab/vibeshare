/**
 * The web spectator view: a minimal, self-contained read-only client served
 * straight from the host machine — no install, no build, no external assets
 * (local-first holds for viewers too; the page phones nowhere).
 *
 * Two modes, same shell:
 *   - default (local loopback): plaintext SSE, JSON payloads
 *   - e2e (tunnel path): SSE data is base64(AES-GCM frame); the page decrypts
 *     with the key from `location.hash` via WebCrypto (mirrors viewerPage.ts)
 *
 * Presence + chat + annotations ride the host multi-party hub (SSE events +
 * POST /chat|/annotate):
 *   - presence roster replaces the bare "N watching" count with named watchers
 *   - chat TEXT is e2e-encrypted with the share key when e2e is on (tunnel);
 *     on pure-local plaintext path the host still stamps identity from the
 *     viewer token. Display text is sanitized against terminal/bidi injection.
 *   - annotations are pinned comments anchored to the feed seq the viewer is
 *     watching, threaded via replyTo; same stamping + e2e rules as chat.
 *
 * Terminal rendering uses inlined xterm.js (CSP-safe, no CDN) so raw PTY
 * bytes reconstruct colors/cursor/full-screen TUI redraws faithfully.
 */

import type { Share } from './types.js';
import { xtermPageStyles } from './xtermClient.js';
import { spectatorBody } from './spectatorPage/page.js';

/**
 * @deprecated Prefer the shared xterm chrome via `xtermPageStyles()`. Kept as
 * a named export so existing importers (viewerPage, tests) keep compiling;
 * content now matches the xterm-era shell.
 */
export const SPECTATOR_CSS = xtermPageStyles();

export interface SpectatorPageOptions {
  /**
   * When true, the served page decrypts SSE payloads with WebCrypto AES-GCM
   * using the key from the URL `#fragment` (tunnel path). Default false —
   * plaintext SSE for the pure-local loopback path.
   */
  readonly e2e?: boolean;
}

export function spectatorPage(share: Share, opts: SpectatorPageOptions = {}): string {
  const e2e = opts.e2e === true;
  const config = JSON.stringify({
    id: share.id,
    name: share.name,
    access: share.access,
    e2e,
  }).replace(/</g, '\\u003c');

  const badgeLine = e2e
    ? '<div class="p2p"><b>●</b> tunnel · end-to-end encrypted</div>'
    : '<div class="p2p"><b>●</b> p2p · nothing stored on a server</div>';

  const chatHint = e2e
    ? 'Say hi — messages are end-to-end encrypted with the share key.'
    : 'Say hi — the host stamps who sent what.';
  return spectatorBody({ share, e2e, badgeLine, chatHint }, config);
}
