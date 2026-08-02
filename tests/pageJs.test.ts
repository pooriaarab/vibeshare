import { describe, expect, it } from 'vitest';
import {
  formatGridFragment,
  gridPage,
  parseGridFragment,
  parseSharePaste,
} from '../src/webrtc/gridPage.js';
import { canvasPage } from '../src/webrtc/canvasPage.js';
import { viewerPage } from '../src/webrtc/viewerPage.js';
import { spectatorPage } from '../src/spectatorPage.js';
import type { Share } from '../src/types.js';

/**
 * Regression guard: the inlined browser JS in the viewer pages must be
 * syntactically valid. Unit tests that only import server functions miss this
 * — a template-literal escape gone wrong (e.g. a raw "\r" that becomes a real
 * carriage return inside a JS string literal) silently breaks the whole page
 * script at runtime. `new Function(js)` throws SyntaxError on such input.
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
    // Throws SyntaxError if the inlined script is malformed.
    expect(() => new Function(js)).not.toThrow();
  }
}

const share: Share = {
  id: 'testShareId1234',
  name: 'test',
  access: 'invite',
  createdAt: new Date().toISOString(),
  expiresAt: null,
  state: 'live',
  passphraseHash: null,
};

/** 32-byte key as base64url (43 chars) — matches real share fragments. */
const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ID_A = 'shareIdAaa1';
const ID_B = 'shareIdBbb2';
const ID_C = 'shareIdCcc3';

describe('inlined viewer-page JS is syntactically valid', () => {
  it('viewerPage (WebRTC) parses', () => expectAllParse(viewerPage()));
  it('gridPage (multi-view) parses', () => expectAllParse(gridPage()));
  it('canvasPage (canvas) parses', () => expectAllParse(canvasPage()));
  it('spectatorPage (SSE, invite) parses', () => expectAllParse(spectatorPage(share)));
  it('spectatorPage (spectate) parses', () => expectAllParse(spectatorPage({ ...share, access: 'spectate' })));
});

describe('gridPage multi-view fragment + shell', () => {
  it('parseGridFragment reads N id~key pairs from the fragment', () => {
    const refs = parseGridFragment(`${ID_A}~${KEY_A},${ID_B}~${KEY_B},${ID_C}~${KEY_C}`);
    expect(refs).toEqual([
      { id: ID_A, key: KEY_A },
      { id: ID_B, key: KEY_B },
      { id: ID_C, key: KEY_C },
    ]);
  });

  it('parseGridFragment accepts a leading # and drops bad pairs', () => {
    expect(parseGridFragment(`#${ID_A}~${KEY_A},bad,x~yy,${ID_B}~${KEY_B}`)).toEqual([
      { id: ID_A, key: KEY_A },
      { id: ID_B, key: KEY_B },
    ]);
    expect(parseGridFragment('')).toEqual([]);
    expect(parseGridFragment('#')).toEqual([]);
  });

  it('parseGridFragment de-dupes by id (first wins)', () => {
    expect(parseGridFragment(`${ID_A}~${KEY_A},${ID_A}~${KEY_B}`)).toEqual([{ id: ID_A, key: KEY_A }]);
  });

  it('formatGridFragment round-trips', () => {
    const refs = [
      { id: ID_A, key: KEY_A },
      { id: ID_B, key: KEY_B },
    ];
    expect(parseGridFragment(formatGridFragment(refs))).toEqual(refs);
  });

  it('parseSharePaste accepts viewer URLs and bare id~key', () => {
    expect(parseSharePaste(`https://getvibe.dev/vibeshare/s/${ID_A}#${KEY_A}`)).toEqual({
      id: ID_A,
      key: KEY_A,
    });
    expect(parseSharePaste(`/vibeshare/s/${ID_A}#${KEY_A}`)).toEqual({ id: ID_A, key: KEY_A });
    expect(parseSharePaste(`/s/${ID_A}#${KEY_A}`)).toEqual({ id: ID_A, key: KEY_A });
    expect(parseSharePaste(`${ID_A}~${KEY_A}`)).toEqual({ id: ID_A, key: KEY_A });
    expect(parseSharePaste('not a link')).toBeNull();
  });

  it('gridPage() HTML is a multi-view shell (grid + add-session)', () => {
    const html = gridPage();
    expect(html).toContain('id="grid"');
    expect(html).toContain('id="addBtn"');
    expect(html).toContain('id="addInput"');
    expect(html).toContain('connectShare');
    expect(html).toContain('/vibeshare/ws/viewer?share=');
    expect(html).toContain('multi-view');
    // Read-only spectate v0 — no drive/chat chrome.
    expect(html).not.toContain('Request to drive');
    expect(html).not.toContain('id="chatForm"');
  });

  it('gridPage() inlined JS handles N fragment shares (cell fan-out)', () => {
    const html = gridPage();
    // The page must parse N id~key pairs and create one cell per share.
    expect(html).toContain('parseGridFragment');
    expect(html).toContain('addShare');
    expect(html).toContain('loadFromHash');
    expect(html).toContain('dataset.shareId');
    // Per-cell xterm + status + expand.
    expect(html).toContain('__vsCreateTerm');
    expect(html).toContain('__vsHandleEntry');
    expect(html).toContain('cell-dot');
    expect(html).toContain('expandCell');

    // Simulate the exported parser for N cells — the page uses the same format.
    const n = 5;
    const refs = Array.from({ length: n }, (_, i) => ({
      id: `shareId${String(i).padStart(4, '0')}`,
      key: KEY_A,
    }));
    const fragment = formatGridFragment(refs);
    const parsed = parseGridFragment(fragment);
    expect(parsed).toHaveLength(n);
    expect(parsed.map((r) => r.id)).toEqual(refs.map((r) => r.id));
  });

  it('viewerPage links into the grid with the current share prefilled', () => {
    const html = viewerPage();
    expect(html).toContain('id="gridLink"');
    expect(html).toContain('/vibeshare/grid#');
  });
});
