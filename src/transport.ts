/**
 * ShareTransport — the one seam vibeshare deliberately leaves open.
 *
 * vibeshare owns the link + the gate. How feed bytes reach viewers is a
 * pluggable transport behind this interface:
 *
 *   - `LocalHttpTransport` (implemented, the default): serves the spectator
 *     web view + an SSE stream directly from the host machine over
 *     loopback/LAN. Fully local-first — bytes go straight from host to
 *     viewer; nothing is stored on any server.
 *
 *   - `RelayTransport` (NOT implemented — lands with vibelive): a dumb,
 *     e2e-encrypted relay that forwards opaque blobs so viewers behind NAT
 *     can reach the host, returning a public `https://vibeshare.io/s/<id>`
 *     URL. The relay never sees plaintext and stores nothing; vibelive owns
 *     the encryption and the p2p mesh. Everything in vibeshare (access
 *     policy, consent, the viewer registry, write-arbitration) is transport-
 *     agnostic and already works — swapping this interface in is the only
 *     change a relay requires.
 *
 * The collaborator *input* channel is part of the same vibelive seam: a
 * transport that accepts remote input MUST route it through
 * `ViewerRegistry.canWrite()` before applying anything to the session.
 */
import type { SessionFeed } from '@pooriaarab/vibe-core/feed';
import type { ViewerRegistry } from './registry.js';
import type { Share } from './types.js';

export interface ShareTransport {
  /** Transport label for diagnostics, e.g. 'local-http'. */
  readonly kind: string;

  /**
   * Begin serving a share. Returns the URL viewers open. Called once per
   * share; a transport may serve many shares concurrently.
   */
  serve(share: Share, feed: SessionFeed, viewers: ViewerRegistry): Promise<string>;

  /**
   * Stop serving one share: disconnect its viewers and make its URL answer
   * as gone. Idempotent.
   */
  unserve(shareId: string): Promise<void>;

  /** Tear the whole transport down (all shares, listeners, sockets). */
  close(): Promise<void>;
}
