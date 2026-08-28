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

/**
 * Result of trying to read a pasted string as a URL. `threw` distinguishes a
 * string the URL constructor rejected outright from one that parsed but simply
 * carried no `/s/<id>` — the original code fell back to a fragment-only paste
 * ONLY in the first case, and a URL that parsed without an id is a rejection.
 */
type PastedUrl = { readonly threw: true } | { readonly threw: false; readonly id: string | null; readonly key: string };

function parseSharePasteUrl(text: string): PastedUrl {
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(text, 'https://getvibe.dev');
    const m =
      /\/(?:vibeshare\/)?s\/([A-Za-z0-9_-]+)/.exec(url.pathname) ??
      /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    const key = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    return { threw: false, id: m?.[1] ?? null, key };
  } catch {
    return { threw: true };
  }
}

/** A bare `id~key` paste — one pair, and no URL punctuation anywhere. */
function bareRef(text: string): GridShareRef | null {
  const bare = parseGridFragment(text);
  if (bare.length === 1 && !text.includes('/') && !text.includes('#')) {
    return bare[0] ?? null;
  }
  return null;
}

/** The id+key a pasted URL yielded, or null when either is absent or malformed. */
function validRef(id: string | null, key: string): GridShareRef | null {
  if (!id || !key) return null;
  if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
  return { id, key };
}

export function parseSharePaste(input: string): GridShareRef | null {
  const text = input.trim();
  if (!text) return null;
  const bare = bareRef(text);
  if (bare) return bare;
  const parsed = parseSharePasteUrl(text);
  // Fall through to a fragment-only paste of id~key with junk only when the
  // URL constructor threw.
  if (parsed.threw) return parseGridFragment(text)[0] ?? null;
  return validRef(parsed.id, parsed.key);
}
