/**
 * The browser spectator/collaborator page for `--public` shares, served by
 * the signaling Worker at `/vibeshare/s/<id>` (see `worker/src/index.ts`).
 *
 * Self-contained and CSP-safe: no external scripts, styles, or fonts — the
 * page phones nowhere except the signaling ws on its own origin and the
 * peer-to-peer DataChannel to the host. Trust model:
 *
 *   - the AES-256-GCM key comes from `location.hash` ONLY (URL fragments are
 *     never sent to any server — the Worker never sees the key),
 *   - the Worker assigns the viewerId; the page runs the WebRTC ANSWER flow
 *     with the native browser `RTCPeerConnection`,
 *   - every DataChannel frame is decrypted with WebCrypto using the slice-1
 *     wire format `nonce(12) ‖ ciphertext ‖ tag(16)`,
 *   - collaborator input carries a per-peer monotonic `seq` INSIDE the
 *     encrypted payload (the host drops replays; see `transport.ts`),
 *   - presence + chat + annotations ride the Worker multi-party hub (NOT the
 *     DataChannel): chat/annotation TEXT is e2e-encrypted with the share key
 *     so the Worker relays ciphertext only; sender identity is stamped by the
 *     Worker from the connection (never trusted from the payload). Display
 *     text is sanitized client-side against terminal/bidi injection (mirrors
 *     vibe-core sanitizePeerText). Annotations are pinned comments anchored
 *     to the feed seq the viewer is watching, threaded via replyTo.
 *
 * Terminal rendering uses the same inlined xterm.js bootstrap as the local
 * spectator page so raw PTY bytes reconstruct the real TUI on both transports.
 */

export { viewerPage } from './viewerPage/page.js';
