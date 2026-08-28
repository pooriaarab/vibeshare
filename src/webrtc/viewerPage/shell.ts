// The HTML shell around viewerPage's inlined script, split verbatim.
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from '../../xtermClient.js';

export const VIEWER_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · live</title>
<style>
  ${xtermPageStyles()}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">vibeshare<span id="shareLabel"></span></div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <a id="gridLink" class="hidden" href="/vibeshare/grid" title="Open this share in the multi-view grid" style="font-family:var(--mono);font-size:12px;color:var(--cyan);text-decoration:none;border:1px solid var(--border-2);border-radius:999px;padding:6px 12px;background:var(--panel)">⊞ grid</a>
      <div class="p2p"><b>●</b> p2p · end-to-end encrypted</div>
    </div>
  </header>

  <div class="panel" id="namePanel">
    <h1>Watch this session live</h1>
    <p>End-to-end encrypted peer-to-peer. Pick a display name so others know who's watching.</p>
    <div class="row">
      <input id="nameInput" placeholder="your name (optional)" maxlength="32" autocomplete="nickname">
      <button id="joinBtn">Watch</button>
    </div>
  </div>

  <div class="panel hidden" id="errPanel">
    <h1>Can't watch this share</h1>
    <p id="errText"></p>
  </div>

  <div class="meta">
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

  <button class="join-btn hidden" id="reqBtn">Request to drive</button>

  <div class="input-row">
    <input id="cmdInput" placeholder="type to drive the session (enabled after host approves)" disabled autocomplete="off">
    <button id="sendBtn" disabled>Send</button>
  </div>

  <div class="chat" id="chatBox">
    <div class="chat-head">Chat · e2e encrypted</div>
    <div class="chat-log" id="chatLog"><div class="chat-empty">Say hi — messages are end-to-end encrypted with the share key.</div></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" placeholder="message the room…" maxlength="500" disabled autocomplete="off">
      <button id="chatSend" type="submit" disabled>Send</button>
    </form>
  </div>

  <div class="chat ann" id="annBox">
    <div class="chat-head">Annotations · pinned to the feed · e2e encrypted</div>
    <div class="chat-log" id="annLog"><div class="chat-empty">No pins yet — pin a comment to the moment you are watching.</div></div>
    <div class="ann-replying hidden" id="annReplying"><span id="annReplyingText"></span><button type="button" id="annReplyCancel">✕</button></div>
    <form class="chat-form" id="annForm">
      <input id="annInput" placeholder="pin a comment at the current moment…" maxlength="500" disabled autocomplete="off">
      <button id="annSend" type="submit" disabled>Pin</button>
    </form>
  </div>
</div>

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}`;

export const VIEWER_TAIL = `</script>
</body>
</html>`;
