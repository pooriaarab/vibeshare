/**
 * Static GET routing for the signaling Worker. Serves the self-contained
 * HTML pages (viewer share page, multi-view grid, canvas grid) with no-store
 * caching and a strict CSP. Logic here is pure request→Response or null —
 * the router in index.ts falls through to the ws paths / 404.
 */
import { canvasPage } from '../../src/webrtc/canvasPage.js';
import { gridPage } from '../../src/webrtc/gridPage.js';
import { viewerPage } from '../../src/webrtc/viewerPage.js';

/** Valid shareId shape: 8-64 URL-safe chars (ids are minted this way). */
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // Self-contained page: inline script/style only, sockets + WebRTC to self.
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Capture a shareId from /vibeshare/s/<id>[/]; null when the path isn't one. */
function pageShareId(pathname: string): string | null {
  const m = /^\/vibeshare\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/**
 * The page Response for a GET page route, or null when the path is not a
 * page (the router then falls through to ws / 404 handling).
 */
export function pageResponse(request: Request, url: URL): Response | null {
  if (request.method !== 'GET') return null;

  if (url.pathname === '/vibeshare/grid' || url.pathname === '/vibeshare/grid/') {
    return new Response(gridPage(), { headers: PAGE_HEADERS });
  }

  if (url.pathname === '/vibeshare/canvas' || url.pathname === '/vibeshare/canvas/') {
    return new Response(canvasPage(), { headers: PAGE_HEADERS });
  }

  if (SHARE_ID_RE.test(pageShareId(url.pathname) ?? '')) {
    return new Response(viewerPage(), { headers: PAGE_HEADERS });
  }
  return null;
}