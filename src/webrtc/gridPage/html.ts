import { xtermPageStyles } from '../../xtermClient.js';

const GRID_EXTRA_CSS = `
.app.grid-app{ max-width:100%; padding:16px 16px 24px; gap:0; }
.grid-app .topbar{ margin-bottom:14px; padding-bottom:14px; }
.grid-tools{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px; }
.grid-tools input{ flex:1 1 220px; min-width:0; }
.grid-tools button{ flex-shrink:0; }
.grid-hint{ font-size:12.5px; color:var(--dim); margin:0 0 14px; line-height:1.4; }
.grid-hint code{ font-family:var(--mono); font-size:11.5px; color:var(--cyan); }
.grid-empty{ background:var(--panel); border:1px dashed var(--border-2); border-radius:12px;
  padding:28px 18px; text-align:center; color:var(--dim); font-size:13.5px; line-height:1.5; }
.grid-empty strong{ color:var(--text); font-weight:600; }
.grid{ display:grid; gap:12px; grid-template-columns:1fr;
  align-items:stretch; width:100%; min-width:0; }
@media (min-width:640px){ .grid{ grid-template-columns:repeat(2, minmax(0, 1fr)); } }
@media (min-width:1100px){ .grid{ grid-template-columns:repeat(3, minmax(0, 1fr)); } }
@media (min-width:1600px){ .grid{ grid-template-columns:repeat(4, minmax(0, 1fr)); } }
.cell{ background:#0d0f14; border:1px solid var(--border); border-radius:12px;
  overflow:hidden; display:flex; flex-direction:column; min-width:0; min-height:220px;
  position:relative; cursor:pointer; transition:border-color .15s ease, box-shadow .15s ease; }
.cell:hover{ border-color:var(--border-2); }
.cell:focus-visible{ outline:2px solid var(--cyan); outline-offset:2px; }
.cell-head{ display:flex; align-items:center; gap:8px; padding:8px 10px;
  background:var(--panel-2); border-bottom:1px solid var(--border); flex-shrink:0; min-width:0; }
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
.cell-body{ flex:1 1 auto; min-height:160px; height:28vh; height:28dvh; padding:2px;
  min-width:0; overflow:hidden; position:relative; }
.cell-body .xterm{ height:100%; width:100%; }
.cell-body .xterm-viewport{ overflow-y:auto !important; }
/* Expanded cell — full viewport overlay */
.cell.expanded{ position:fixed; inset:12px; z-index:40; min-height:0; height:auto;
  box-shadow:0 24px 80px rgba(0,0,0,.55); border-color:var(--border-2); cursor:default; }
.cell.expanded .cell-body{ height:auto; flex:1 1 auto; min-height:0; }
body.grid-expanded{ overflow:hidden; }
.expand-backdrop{ position:fixed; inset:0; background:rgba(5,6,10,.72); z-index:30;
  border:0; padding:0; cursor:pointer; }
.grid-err{ color:var(--red); font-size:12.5px; margin:0 0 10px; min-height:1.2em; }
.grid-link{ font-size:12.5px; color:var(--cyan); text-decoration:none; }
.grid-link:hover{ text-decoration:underline; }
@media (max-width:639px){
  .cell-body{ height:36vh; height:36dvh; min-height:180px; }
  .cell.expanded{ inset:0; border-radius:0; }
}
`;

export function gridHtmlHead(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · grid</title>
<style>
  ${xtermPageStyles(GRID_EXTRA_CSS)}
</style>
</head>
<body>`;
}

export function gridHtmlBody(): string {
  return `<div class="app grid-app">
  <header class="topbar">
    <div class="brand">vibeshare<span> · multi-view</span></div>
    <div class="p2p"><b>●</b> p2p · end-to-end encrypted</div>
  </header>

  <p class="grid-hint">
    Watch several live shares at once. Keys stay in the URL fragment
    (<code>#id~key,id~key,…</code>) and never hit the server. Click a cell to expand.
  </p>

  <div class="grid-tools">
    <input id="addInput" placeholder="paste a share URL (…/s/<id>#<key>) or id~key" autocomplete="off" spellcheck="false">
    <button type="button" id="addBtn" title="Add a session to the grid">＋ add a session</button>
    <a class="grid-link" href="/vibeshare/canvas" title="Switch to the free-form canvas board" style="margin-left:auto">⬚ canvas</a>
  </div>
  <div class="grid-err" id="addErr" aria-live="polite"></div>

  <div class="grid-empty" id="emptyState">
    <strong>No sessions yet.</strong><br>
    Paste a vibeshare link above, or open this page as
    <code>/vibeshare/grid#id~key,id2~key2</code>.
  </div>

  <div class="grid" id="grid" hidden></div>
</div>`;
}
