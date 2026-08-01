import { describe, expect, it } from 'vitest';
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

describe('inlined viewer-page JS is syntactically valid', () => {
  it('viewerPage (WebRTC) parses', () => expectAllParse(viewerPage()));
  it('spectatorPage (SSE, invite) parses', () => expectAllParse(spectatorPage(share)));
  it('spectatorPage (spectate) parses', () => expectAllParse(spectatorPage({ ...share, access: 'spectate' })));
});
