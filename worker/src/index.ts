/**
 * vibeshare signaling rendezvous — a Cloudflare Worker + one Durable Object
 * per shareId. It exists for exactly one job: carry the WebRTC
 * offer/answer/ICE handshake between a vibeshare host (`vibeshare --public`)
 * and browser viewers. Session bytes never cross it — they flow host→viewer
 * over an AES-256-GCM DataChannel; the key lives only in the share URL
 * `#fragment`, which browsers never send to any server.
 *
 * The Worker is the identity authority (this is what makes the rendezvous
 * safe to run as a public service):
 *
 *   - viewerIds are MINTED here (crypto.randomUUID), one per viewer socket —
 *     a viewer cannot choose or claim another viewer's id;
 *   - every relayed frame is STAMPED with the connection's own
 *     (shareId, viewerId, from) — client-supplied identity fields are
 *     discarded, so there is no cross-pair injection or impersonation;
 *   - the host authenticates with a host-secret it minted when the share was
 *     created; the first secret presented for a share is bound durably and
 *     later host connections must match (viewers never see it);
 *   - the relay is a whitelist: rtc-offer / rtc-answer / rtc-ice (point-to-point
 *     handshake) plus rtc-ice-servers (host→viewer ONLY: the host's STUN/TURN
 *     bootstrap, relayed verbatim — the Worker never inspects creds) plus
 *     presence / hello / chat / annotation / join-request /
 *     role-update (multi-party hub frames). Chat + annotation TEXT is
 *     end-to-end ciphertext — the Worker never decrypts it. Sender identity on
 *     chat/annotation/join-request is STAMPED from the connection attachment;
 *     annotation ids are minted here. Keys, session bytes, and every other
 *     frame shape are dropped.
 *
 * Availability / isolation hardening (see ./limits.ts for tunable constants):
 *
 *   - max viewers per share (host exempt);
 *   - per-IP sliding-window connection rate limit (CF-Connecting-IP);
 *   - DO storage cleanup alarm (hard ceiling + abandoned short reclaim);
 *   - viewer-with-no-host timeout (guessed/expired ids fail closed).
 *
 * Protocol (mirrored by src/webrtc/wsSignaling.ts + src/webrtc/viewerPage.ts):
 *
 *   GET /vibeshare/s/<id>                          → the viewer page (HTML)
 *   GET /vibeshare/grid                            → multi-view grid page (HTML)
 *   GET /vibeshare/ws/host?share=<id>&secret=<s>   → host socket
 *   GET /vibeshare/ws/viewer?share=<id>            → viewer socket
 *   GET /vibeshare/health                          → liveness
 */
// This module is the router only: the bindings interface, the static pages
// and the ShareRoom DO live in sibling modules (env.ts / pages.ts /
// shareRoom.ts) so each file stays under the lint size budget. The module
// entry point is unchanged — wrangler still bundles from src/index.ts and
// the DO class is still exported (and bound) under the name `ShareRoom`.
import { pageResponse, SHARE_ID_RE } from './pages.js';
import type { Env } from './env.js';
export { ShareRoom } from './shareRoom.js';
export type { Env } from './env.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/vibeshare/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const page = pageResponse(request, url);
    if (page) return page;

    if (url.pathname === '/vibeshare/ws/host' || url.pathname === '/vibeshare/ws/viewer') {
      const shareId = url.searchParams.get('share') ?? '';
      if (!SHARE_ID_RE.test(shareId)) {
        return new Response('missing or invalid share id', { status: 400 });
      }
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return new Response('expected a WebSocket upgrade', { status: 426 });
      }
      const room = env.SHARES.get(env.SHARES.idFromName(shareId));
      return room.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;