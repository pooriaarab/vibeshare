import type { GridShareRef } from './types.js';

const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Parse a grid URL fragment (`#` optional) into share refs.
 * Invalid pairs are dropped; first occurrence of an id wins.
 */
export function parseGridFragment(fragment: string): GridShareRef[] {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return [];
  const out: GridShareRef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const tilde = part.indexOf('~');
    if (tilde <= 0) continue;
    const id = part.slice(0, tilde).trim();
    const key = part.slice(tilde + 1).trim();
    if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, key });
  }
  return out;
}

/** Serialize share refs back to a fragment body (no leading `#`). */
export function formatGridFragment(shares: readonly GridShareRef[]): string {
  return shares.map((s) => `${s.id}~${s.key}`).join(',');
}

function parseSharePasteUrl(text: string): { id: string; key: string } | null {
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(text, 'https://getvibe.dev');
    const m =
      /\/(?:vibeshare\/)?s\/([A-Za-z0-9_-]+)/.exec(url.pathname) ??
      /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    if (!m) return null;
    const id = m[1];
    if (!id) return null;
    const key = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    return { id, key };
  } catch {
    return null;
  }
}

/**
 * Pull `{id, key}` from a pasted single-share viewer URL or a bare `id~key`.
 * Accepts `/vibeshare/s/<id>#<key>`, `/s/<id>#<key>`, full origins, or `id~key`.
 */
export function parseSharePaste(input: string): GridShareRef | null {
  const text = input.trim();
  if (!text) return null;
  // Bare id~key (same as one fragment pair).
  const bare = parseGridFragment(text);
  if (bare.length === 1 && !text.includes('/') && !text.includes('#')) {
    return bare[0] ?? null;
  }
  const parsed = parseSharePasteUrl(text);
  if (parsed) {
    const { id, key } = parsed;
    if (SHARE_ID_RE.test(id) && KEY_RE.test(key)) {
      return { id, key };
    }
    return null;
  }
  const pair = parseGridFragment(text);
  return pair[0] ?? null;
}
