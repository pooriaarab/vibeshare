import { xtermPageStyles } from '../../xtermClient.js';

const CANVAS_EXTRA_CSS = `
.app.canvas-app{ max-width:100%; padding:16px 16px 24px; gap:0; }
.canvas-app .topbar{ margin-bottom:14px; padding-bottom:14px; }
.canvas-tools{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px; }
.canvas-tools input{ flex:1 1 220px; min-width:0; }
.canvas-tools button{ flex-shrink:0; }
.canvas-zoom{ display:inline-flex; align-items:center; gap:6px; flex-shrink:0;
  font-family:var(--mono); font-size:11.5px; color:var(--faint);
  background:var(--panel); border:1px solid var(--border); border-radius:999px; padding:4px 6px; }
.canvas-zoom button{ min-width:30px; min-height:0; padding:3px 8px; font-size:13px; line-height:1; }
.canvas-zoom #zoomLabel{ min-width:38px; text-align:center; }
.canvas-hint{ font-size:12.5px; color:var(--dim); margin:0 0 14px; line-height:1.4; }
.canvas-hint code{ font-family:var(--mono); font-size:11.5px; color:var(--cyan); }
.canvas-empty{ background:var(--panel); border:1px dashed var(--border-2); border-radius:12px;
  padding:28px 18px; text-align:center; color:var(--dim); font-size:13.5px; line-height:1.5; }
.canvas-empty strong{ color:var(--text); font-weight:600; }
.viewport{ position:relative; width:100%; height:calc(100vh - 240px); min-height:320px;
  overflow:hidden; background:var(--panel-2); border:1px solid var(--border); border-radius:12px;
  cursor:grab; touch-action:none; }
.viewport.panning{ cursor:grabbing; }
.viewport[hidden]{ display:none; }
.board{ position:absolute; left:0; top:0; width:0; height:0;
  transform-origin:0 0; will-change:transform; }
.cell{ position:absolute; width:340px; background:#0d0f14; border:1px solid var(--border);
  border-radius:12px; overflow:hidden; display:flex; flex-direction:column; min-width:0;
  min-height:220px; box-shadow:0 10px 28px rgba(0,0,0,.4);
  transition:border-color .15s ease, box-shadow .15s ease; }
.cell:hover{ border-color:var(--border-2); }
.cell-head{ display:flex; align-items:center; gap:8px; padding:8px 10px;
  background:var(--panel-2); border-bottom:1px solid var(--border); flex-shrink:0; min-width:0;
  cursor:grab; user-select:none; -webkit-user-select:none; }
.cell-head:active{ cursor:grabbing; }
.cell-dot{ width:8px; height:8px; border-radius:50%; background:var(--faint); flex-shrink:0; }
.cell-dot.live{ background:var(--green); box-shadow:0 0 0 3px rgba(126,231,135,.15); }
.cell-dot.connecting{ background:var(--cyan); }
.cell-dot.dead{ background:var(--red); }
.cell-id{ font-family:var(--mono); font-size:12px; color:var(--text); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.cell-status{ font-family:var(--mono); font-size:10.5px; color:var(--faint); letter-spacing:.03em;
  text-transform:uppercase; flex-shrink:0; }
.cell-remove{ flex-shrink:0; font-size:14px; line-height:1; padding:4px 8px; min-height:0;
  color:var(--faint); background:transparent; border:1px solid transparent; border-radius:6px; }
.cell-remove:hover{ color:var(--red); border-color:var(--border); background:var(--panel-3); }
.cell-body{ flex:1 1 auto; min-height:160px; height:240px; padding:2px;
  min-width:0; overflow:hidden; position:relative; }
.cell-body .xterm{ height:100%; width:100%; }
.cell-body .xterm-viewport{ overflow-y:auto !important; }
.canvas-err{ color:var(--red); font-size:12.5px; margin:0 0 10px; min-height:1.2em; }
.mode-link{ font-size:12.5px; color:var(--cyan); text-decoration:none; margin-left:auto;
  font-family:var(--mono); }
.mode-link:hover{ text-decoration:underline; }
@media (max-width:639px){
  .cell{ width:calc(100vw - 48px); max-width:340px; }
  .viewport{ height:calc(100vh - 280px); }
  .mode-link{ margin-left:0; }
}
`;

export function canvasHtmlHead(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · canvas</title>
<style>
  ${xtermPageStyles(CANVAS_EXTRA_CSS)}
</style>
</head>
<body>`;
}

export function canvasHtmlBody(): string {
  return `<div class="app canvas-app">
  <header class="topbar">
    <div class="brand">vibeshare<span> · canvas</span></div>
    <div class="p2p"><b>●</b> p2p · end-to-end encrypted</div>
  </header>

  <p class="canvas-hint">
    Drop live shares on a free-form board. Drag a cell header to move it,
    drag the background to pan, scroll to zoom. Keys stay in the URL fragment
    (<code>#id~key~x~y,…</code>) and never hit the server.
  </p>

  <div class="canvas-tools">
    <input id="addInput" placeholder="paste a share URL (…/s/<id>#<key>) or id~key" autocomplete="off" spellcheck="false">
    <button type="button" id="addBtn" title="Add a session to the board">＋ add a session</button>
    <span class="canvas-zoom">
      <button type="button" id="zoomOut" title="Zoom out" aria-label="Zoom out">−</button>
      <span id="zoomLabel">100%</span>
      <button type="button" id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
    </span>
    <a class="mode-link" href="/vibeshare/grid" title="Switch to the fixed multi-view grid">⊞ grid</a>
  </div>
  <div class="canvas-err" id="addErr" aria-live="polite"></div>

  <div class="canvas-empty" id="emptyState">
    <strong>No sessions yet.</strong><br>
    Paste a vibeshare link above, or open this page as
    <code>/vibeshare/canvas#id~key~x~y</code>.
  </div>

  <div class="viewport" id="viewport" hidden>
    <div class="board" id="board"></div>
  </div>
</div>`;
}
