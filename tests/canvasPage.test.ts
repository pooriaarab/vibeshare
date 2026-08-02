import { describe, expect, it } from 'vitest';
import {
  canvasPage,
  formatCanvasFragment,
  parseCanvasFragment,
  type CanvasShareRef,
} from '../src/webrtc/canvasPage.js';

/**
 * Regression guard: the inlined browser JS must be syntactically valid.
 * `new Function(js)` throws SyntaxError on a malformed template escape
 * (e.g. a raw "\r" emitted inside a JS string literal).
 */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? '');
  return out;
}

function expectAllParse(html: string): void {
  const scripts = inlineScripts(html);
  expect(scripts.length).toBeGreaterThan(0);
  for (const js of scripts) {
    expect(() => new Function(js)).not.toThrow();
  }
}

/** 32-byte key as base64url (43 chars) — matches real share fragments. */
const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ID_A = 'shareIdAaa1';
const ID_B = 'shareIdBbb2';
const ID_C = 'shareIdCcc3';

describe('canvasPage canvas fragment parsing', () => {
  it('parseCanvasFragment reads N positioned id~key~x~y pairs', () => {
    const refs = parseCanvasFragment(
      `${ID_A}~${KEY_A}~10~20,${ID_B}~${KEY_B}~300~80,${ID_C}~${KEY_C}~-5~0`,
    );
    expect(refs).toEqual([
      { id: ID_A, key: KEY_A, x: 10, y: 20 },
      { id: ID_B, key: KEY_B, x: 300, y: 80 },
      { id: ID_C, key: KEY_C, x: -5, y: 0 },
    ]);
  });

  it('accepts a leading # and drops bad pairs (bad id/key)', () => {
    expect(parseCanvasFragment(`#${ID_A}~${KEY_A}~1~2,bad,x~yy~1~2,${ID_B}~${KEY_B}~3~4`)).toEqual([
      { id: ID_A, key: KEY_A, x: 1, y: 2 },
      { id: ID_B, key: KEY_B, x: 3, y: 4 },
    ]);
    expect(parseCanvasFragment('')).toEqual([]);
    expect(parseCanvasFragment('#')).toEqual([]);
  });

  it('tolerates missing x/y by auto-placing at (0,0)', () => {
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}`)).toEqual([
      { id: ID_A, key: KEY_A, x: 0, y: 0 },
    ]);
    // A lone x with no y is malformed → defaults to (0,0) (tolerant).
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}~10`)).toEqual([
      { id: ID_A, key: KEY_A, x: 0, y: 0 },
    ]);
  });

  it('parses x/y as integers (truncates; rejects NaN coords)', () => {
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}~10.7~20.9`)).toEqual([
      { id: ID_A, key: KEY_A, x: 10, y: 20 },
    ]);
    // Non-numeric coordinate present → whole pair dropped (reject NaN).
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}~abc~20`)).toEqual([]);
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}~10~xyz`)).toEqual([]);
  });

  it('de-dupes by id (first wins)', () => {
    expect(parseCanvasFragment(`${ID_A}~${KEY_A}~1~2,${ID_A}~${KEY_B}~3~4`)).toEqual([
      { id: ID_A, key: KEY_A, x: 1, y: 2 },
    ]);
  });

  it('formatCanvasFragment round-trips with positions', () => {
    const refs: CanvasShareRef[] = [
      { id: ID_A, key: KEY_A, x: 10, y: 20 },
      { id: ID_B, key: KEY_B, x: -3, y: 400 },
    ];
    expect(formatCanvasFragment(refs)).toBe(`${ID_A}~${KEY_A}~10~20,${ID_B}~${KEY_B}~-3~400`);
    expect(parseCanvasFragment(formatCanvasFragment(refs))).toEqual(refs);
  });

  it('formatCanvasFragment of empty is empty', () => {
    expect(formatCanvasFragment([])).toBe('');
  });
});

describe('canvasPage() board shell + inlined JS', () => {
  it('canvasPage() HTML is a board shell (viewport + board + add-session)', () => {
    const html = canvasPage();
    expect(html).toContain('id="viewport"');
    expect(html).toContain('id="board"');
    expect(html).toContain('id="addBtn"');
    expect(html).toContain('id="addInput"');
    expect(html).toContain('connectShare');
    expect(html).toContain('/vibeshare/ws/viewer?share=');
    expect(html).toContain('canvas');
    // Brand label uses the canvas suffix.
    expect(html).toContain('vibeshare<span> · canvas</span>');
    // Read-only spectate v0 — no drive/chat chrome.
    expect(html).not.toContain('Request to drive');
    expect(html).not.toContain('id="chatForm"');
  });

  it('canvasPage() inlined JS carries the board view + per-cell fan-out', () => {
    const html = canvasPage();
    expect(html).toContain('parseCanvasFragment');
    expect(html).toContain('formatCanvasFragment');
    expect(html).toContain('addShare');
    expect(html).toContain('loadFromHash');
    expect(html).toContain('dataset.shareId');
    // Per-cell xterm + status.
    expect(html).toContain('__vsCreateTerm');
    expect(html).toContain('__vsHandleEntry');
    expect(html).toContain('cell-dot');
    // Pan / zoom / cell-drag.
    expect(html).toContain('panning');
    expect(html).toContain('setZoom');
    expect(html).toContain('startCellDrag');
    expect(html).toContain('MIN_ZOOM');
    expect(html).toContain('MAX_ZOOM');

    // Simulate the exported parser for N positioned cells.
    const n = 5;
    const refs = Array.from({ length: n }, (_, i) => ({
      id: `shareId${String(i).padStart(4, '0')}`,
      key: KEY_A,
      x: i * 100,
      y: i * 60,
    }));
    const fragment = formatCanvasFragment(refs);
    const parsed = parseCanvasFragment(fragment);
    expect(parsed).toHaveLength(n);
    expect(parsed.map((r) => r.id)).toEqual(refs.map((r) => r.id));
    expect(parsed.map((r) => ({ x: r.x, y: r.y }))).toEqual(refs.map((r) => ({ x: r.x, y: r.y })));
  });

  it('canvasPage() inlined scripts are syntactically valid (parse-guard)', () => {
    expectAllParse(canvasPage());
  });

  it('canvasPage() links back to the grid mode', () => {
    expect(canvasPage()).toContain('href="/vibeshare/grid"');
  });
});
