/**
 * The URL / capability-id layer of vibeshare.
 *
 * Pure logic — no IO — so every function here is directly unit-tested in
 * `src/url.test.ts`. A share link is a **capability URL**: the id is the only
 * thing that grants access, so it must be unguessable. The human-facing host is
 * vibeshare's own domain (`vibeshare.stream`); the actual transport is the
 * local/LAN ws relay owned by vibelive, which the URL only *represents*.
 *
 * Ids are minted by `newShareId` in `./utils.js` — the single canonical
 * implementation (an earlier duplicate here diverged in shape and entropy).
 */

/**
 * The display origin for vibeshare share links. This is vibeshare's OWN domain —
 * not vibe.live — so a shared link reads as vibeshare even though the bytes flow
 * over a self-hostable e2e relay (see docs/spec.md · "its OWN domain, not
 * vibe.live").
 */
export const SHARE_ORIGIN = 'https://vibeshare.stream';

/** Path prefix for share links: `<origin>/s/<id>`. */
export const SHARE_PATH_PREFIX = '/s/';

/**
 * Build the human-facing share URL for a capability id.
 *
 * The URL is for *display and parsing only* — opening it resolves to the
 * vibeshare spectator view, which then connects to the host's local/LAN relay.
 * The relay URL is carried out-of-band (printed next to the share URL by the CLI).
 */
export function buildShareUrl(id: string, origin: string = SHARE_ORIGIN): string {
  return `${origin}${SHARE_PATH_PREFIX}${id}`;
}

/** Error thrown when a string cannot be parsed as a vibeshare share URL. */
export class ShareUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareUrlParseError';
  }
}

/**
 * Parse a vibeshare share URL (or bare `/s/<id>` path) back into its capability id.
 *
 * Accepts:
 *   - full URLs: `https://vibeshare.stream/s/<id>`, `http://...`, with or without
 *     a trailing slash or query string;
 *   - bare paths: `/s/<id>`;
 *   - any origin host (we key off the `/s/` segment, not the host, so self-hosted
 *     / vanity domains round-trip too).
 *
 * Pure and total: throws {@link ShareUrlParseError} on input with no `/s/` segment.
 * Round-trips {@link buildShareUrl}: `parseShareUrl(buildShareUrl(id)).id === id`.
 */
export function parseShareUrl(url: string): { readonly id: string } {
  if (typeof url !== 'string' || url.length === 0) {
    throw new ShareUrlParseError('share url must be a non-empty string');
  }
  const idx = url.indexOf(SHARE_PATH_PREFIX);
  if (idx < 0) {
    throw new ShareUrlParseError(`not a vibeshare share url (missing "${SHARE_PATH_PREFIX}"): ${url}`);
  }
  // Everything after `/s/`, up to the next path separator, query, or fragment.
  const tail = url.slice(idx + SHARE_PATH_PREFIX.length);
  const end = tail.search(/[/?#]/);
  const id = end < 0 ? tail : tail.slice(0, end);
  if (id.length === 0) {
    throw new ShareUrlParseError(`share url has an empty id: ${url}`);
  }
  return { id };
}
