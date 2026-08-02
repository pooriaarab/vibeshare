/**
 * Shared browser-side xterm.js bootstrap for spectator/viewer pages.
 *
 * Boot JS + chrome CSS come from `@pooriaarab/vibe-core/xterm`. The heavy
 * library payloads (xterm.js UMD, FitAddon UMD, xterm.css) stay local
 * (`scripts/embed-xterm.mjs` → `src/generated/xtermAssets.ts`) and are
 * injected here so pages stay self-contained under CSP
 * `script-src 'unsafe-inline'`.
 *
 * Page-specific UI (presence/chat/annotations/export/invite-drive) lives in
 * spectatorPage.ts / viewerPage.ts — only the xterm boot/styles are shared.
 */
import {
  XTERM_BOOT_JS,
  XTERM_CHROME_CSS,
  xtermPageStyles as corePageStyles,
  xtermScriptTags as coreScriptTags,
} from '@pooriaarab/vibe-core/xterm';
import { XTERM_CSS, XTERM_FIT_JS, XTERM_JS } from './generated/xtermAssets.js';

export { XTERM_BOOT_JS, XTERM_CHROME_CSS };

/** xterm CSS + vibe chrome styles (+ optional page overrides). */
export function xtermPageStyles(extraCss = ''): string {
  return corePageStyles(XTERM_CSS, extraCss);
}

/** Inline <script> tags that load xterm + FitAddon onto globalThis (UMD). */
export function xtermScriptTags(): string {
  return coreScriptTags(XTERM_JS, XTERM_FIT_JS);
}
