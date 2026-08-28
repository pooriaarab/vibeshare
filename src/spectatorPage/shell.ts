// The HTML shell around the spectator page's inlined script, split verbatim
// from the original template literal.
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from '../xtermClient.js';
import type { Share } from '../types.js';

export interface ShellCtx {
  readonly share: Share;
  readonly e2e: boolean;
  readonly badgeLine: string;
  readonly chatHint: string;
}

function SHELL_1(ctx: ShellCtx): string {
  const { share, e2e, badgeLine, chatHint } = ctx;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · ${escapeHtml(share.name)}</title>
<style>
  ${xtermPageStyles()}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">vibeshare<span id="sessionName"></span></div>
    ${badgeLine}
  </header>

  <div class="panel" id="joinPanel">
    <h1>Watch this session live</h1>
    <p>${e2e ? 'Read-only. Stream is end-to-end encrypted — the tunnel only sees ciphertext.' : 'Read-only. The stream comes straight from the host machine.'}</p>
    <div class="row">
      <input id="nameInput" placeholder="your name (optional)" maxlength="32" autocomplete="nickname">
      <input id="passInput" placeholder="passphrase" type="password" class="hidden">
      <button id="watchBtn">Watch</button>
    </div>
    <div class="err" id="joinErr"></div>
  </div>
`;
}

const SHELL_2 = `  <div class="meta">
    <span class="badge" id="badge"><span class="d"></span> CONNECTING</span>
    <button type="button" class="presence toggleable" id="presenceLabel" aria-expanded="false" title="Show who's watching">👁 <b id="watching">0</b> watching</button>
  </div>

  <div class="term">
    <div class="chrome">
      <span></span><span></span><span></span>
      <span class="path" id="chromePath"></span>
      <div class="term-tools" role="group" aria-label="Terminal font size">
        <button type="button" class="font-btn" id="fontDec" title="Smaller text" aria-label="Decrease terminal font size">A−</button>
        <button type="button" class="font-btn" id="fontInc" title="Larger text" aria-label="Increase terminal font size">A+</button>
      </div>
    </div>
    <div class="term-body" id="termBody"></div>
  </div>

  <div class="export-bar" id="exportBar">
    <button type="button" id="exportPngBtn" title="Download a PNG of the visible terminal">Export PNG</button>
    <button type="button" id="exportTextBtn" title="Download the full terminal scrollback as plain text">Export text</button>
  </div>

  <button class="pin-btn hidden" id="pinBtn" title="pin a comment at the feed position you are watching">📌 pin a comment here</button>

  <button class="join-btn hidden" id="reqBtn">Request to join</button>

  <div class="input-row hidden" id="inputRow">
    <input id="cmdInput" placeholder="type to drive the session" disabled autocomplete="off">`;

function SHELL_3(ctx: ShellCtx): string {
  const { share, e2e, badgeLine, chatHint } = ctx;
  return `    <button id="sendBtn" disabled>Send</button>
  </div>

  <div class="chat hidden" id="chatBox">
    <div class="chat-head">Chat${e2e ? ' · e2e encrypted' : ''}</div>
    <div class="chat-log" id="chatLog"><div class="chat-empty">${chatHint}</div></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" placeholder="message the room…" maxlength="500" autocomplete="off">
      <button id="chatSend" type="submit">Send</button>
    </form>
  </div>

  <div class="chat ann hidden" id="annBox">
    <div class="chat-head">Annotations · pinned to the feed${e2e ? ' · e2e encrypted' : ''}</div>
    <div class="chat-log" id="annLog"><div class="chat-empty">No pins yet — pin a comment to the moment you are watching.</div></div>
    <div class="ann-replying hidden" id="annReplying"><span id="annReplyingText"></span><button type="button" id="annReplyCancel">✕</button></div>
    <form class="chat-form" id="annForm">
      <input id="annInput" placeholder="pin a comment at the current moment…" maxlength="500" autocomplete="off">
      <button id="annSend" type="submit">Pin</button>
    </form>
  </div>
</div>

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}`;
}

/** The HTML shell, reassembled from its verbatim slices. */
export function spectatorShell(ctx: ShellCtx): string {
  return `${SHELL_1(ctx)}
${SHELL_2}
${SHELL_3(ctx)}`;
}

export const SPECTATOR_TAIL = `</script>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
