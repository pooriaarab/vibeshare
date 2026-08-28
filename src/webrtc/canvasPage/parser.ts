import type { CanvasShareRef } from './types.js';

const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

function parseCanvasPair(part: string): CanvasShareRef | null {
  const segs = part.split('~');
  const id = (segs[0] ?? '').trim();
  const key = (segs[1] ?? '').trim();
  if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
  let x = 0;
  let y = 0;
  if (segs.length >= 4) {
    const px = parseInt((segs[2] ?? '').trim(), 10);
    const py = parseInt((segs[3] ?? '').trim(), 10);
    if (Number.isNaN(px) || Number.isNaN(py)) return null;
    x = px;
    y = py;
  }
  return { id, key, x, y };
}

/**
 * Parse a canvas URL fragment (`#` optional) into positioned share refs.
 */
export function parseCanvasFragment(fragment: string): CanvasShareRef[] {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return [];
  const out: CanvasShareRef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const parsed = parseCanvasPair(part);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/** Serialize positioned share refs back to a fragment body (no leading `#`). */
export function formatCanvasFragment(shares: readonly CanvasShareRef[]): string {
  return shares.map((s) => `${s.id}~${s.key}~${s.x}~${s.y}`).join(',');
}
