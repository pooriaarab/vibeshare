/**
 * Shared browser-side xterm.js bootstrap + feed-entry handler, inlined into
 * both spectatorPage (SSE) and viewerPage (WebRTC). Kept as plain JS source
 * strings so pages stay self-contained under CSP `script-src 'unsafe-inline'`.
 */
import { XTERM_CSS, XTERM_FIT_JS, XTERM_JS } from './generated/xtermAssets.js';

/** xterm CSS + vibeshare chrome styles that wrap the terminal. */
export function xtermPageStyles(extraCss = ''): string {
  return `${XTERM_CSS}
:root{ --bg:#0a0b0f; --panel:#12141a; --panel-2:#171a22; --panel-3:#1d2129;
  --border:rgba(255,255,255,.08); --border-2:rgba(255,255,255,.14);
  --text:#edeef3; --dim:#9aa0b2; --faint:#666c7c; --cyan:#67e8f9;
  --violet:#c4b5fd; --green:#7ee787; --red:#ff8b85;
  --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --app-pad-x:22px; --app-pad-y:26px; --touch:44px; }
*{ box-sizing:border-box; }
html{ height:100%; width:100%; overflow-x:hidden; }
body{ margin:0; background:var(--bg); color:var(--text); font-family:var(--sans);
  -webkit-font-smoothing:antialiased; min-height:100%; min-height:100vh; min-height:100dvh;
  width:100%; max-width:100%; overflow-x:hidden; }
.app{ width:100%; max-width:1100px; margin:0 auto;
  padding:var(--app-pad-y) var(--app-pad-x) calc(var(--app-pad-y) + env(safe-area-inset-bottom,0px));
  display:flex; flex-direction:column; min-height:100vh; min-height:100dvh;
  gap:0; }
.topbar{ display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding-bottom:18px; margin-bottom:20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.brand{ font-size:17px; font-weight:650; letter-spacing:-.01em; min-width:0; }
.brand span{ color:var(--faint); font-size:12.5px; font-weight:450; margin-left:9px; word-break:break-all; }
.p2p{ font-family:var(--mono); font-size:12px; color:var(--dim); background:var(--panel);
  border:1px solid var(--border-2); border-radius:999px; padding:6px 13px; white-space:nowrap; flex-shrink:0; }
.p2p b{ color:var(--green); font-weight:600; }
.meta{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
.badge{ display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700;
  letter-spacing:.03em; color:var(--cyan); background:rgba(103,232,249,.1);
  border:1px solid rgba(103,232,249,.3); border-radius:999px; padding:5px 11px; }
.badge.collab{ color:var(--violet); background:rgba(196,181,253,.12); border-color:rgba(196,181,253,.35); }
.badge.ended{ color:var(--red); background:rgba(255,139,133,.1); border-color:rgba(255,139,133,.35); }
.badge .d{ width:6px; height:6px; border-radius:50%; background:currentColor; }
.count{ font-family:var(--mono); font-size:12.5px; color:var(--dim); }
.count b{ color:var(--text); }
.term{ background:#0d0f14; border:1px solid var(--border); border-radius:12px; overflow:hidden;
  display:flex; flex-direction:column; flex:1 1 auto; min-height:280px; min-width:0; max-width:100%; }
.chrome{ display:flex; align-items:center; gap:6px; padding:10px 12px;
  background:var(--panel-2); border-bottom:1px solid var(--border); flex-shrink:0; min-width:0; }
.chrome span{ width:9px; height:9px; border-radius:50%; background:#3a3f4b; flex-shrink:0; }
.chrome .path{ margin-left:8px; font-family:var(--mono); font-size:11.5px; color:var(--faint);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.term-tools{ margin-left:auto; display:flex; align-items:center; gap:4px; flex-shrink:0; }
.font-btn{ font-family:var(--sans); font-size:12px; font-weight:700; letter-spacing:.02em;
  color:var(--dim); background:var(--panel-3); border:1px solid var(--border);
  border-radius:6px; padding:4px 10px; min-height:28px; min-width:32px; line-height:1; cursor:pointer; }
.font-btn:hover{ color:var(--text); background:#242933; border-color:var(--border-2); }
.font-btn:active{ transform:translateY(1px); }
.term-body{ flex:1 1 auto; min-height:240px; height:56vh; height:56dvh; padding:4px;
  min-width:0; max-width:100%; overflow:hidden; position:relative; }
.term-body .xterm{ height:100%; width:100%; }
.term-body .xterm-viewport{ overflow-y:auto !important; }
/* Horizontal overflow stays inside the terminal surface — never the page body. */
.term-body .xterm-screen{ overflow-x:auto; }
.panel{ background:var(--panel); border:1px solid var(--border); border-radius:12px;
  padding:18px; margin-bottom:16px; min-width:0; }
.panel h1{ font-size:15px; margin:0 0 4px; }
.panel p{ font-size:13px; color:var(--dim); margin:0 0 14px; }
.row{ display:flex; gap:10px; flex-wrap:wrap; }
input{ flex:1; min-width:160px; font-family:var(--mono); font-size:16px; color:var(--text);
  background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px;
  max-width:100%; }
input:focus{ outline:none; border-color:var(--cyan); }
.err{ color:var(--red); font-size:12.5px; margin-top:10px; display:none; }
button{ font-family:inherit; font-size:13px; font-weight:600; color:var(--text);
  background:var(--panel-3); border:1px solid var(--border-2); border-radius:8px;
  padding:10px 16px; cursor:pointer; }
button:hover{ background:#242933; }
button:disabled{ opacity:.6; cursor:default; }
.join-btn{ margin-top:14px; background:#3a3160; border-color:rgba(196,181,253,.5); color:#f2eeff;
  min-height:var(--touch); width:100%; max-width:100%; }
.join-btn:hover{ background:#453a78; }
.join-btn.pending{ background:var(--panel-3); border-color:var(--border-2); color:var(--dim); }
.join-btn.joined{ background:rgba(126,231,135,.12); border-color:rgba(126,231,135,.4); color:var(--green); }
.hidden{ display:none !important; }
.input-row{ display:flex; gap:10px; margin-top:14px; min-width:0; }
.input-row input{ min-width:0; }
.presence{ font-family:var(--mono); font-size:12.5px; color:var(--dim); max-width:100%;
  border:0; background:transparent; padding:0; text-align:left; line-height:1.4; }
.presence b{ color:var(--text); }
.presence .names{ color:var(--dim); }
.presence .names em{ font-style:normal; color:var(--text); }
.presence.toggleable{ cursor:pointer; -webkit-tap-highlight-color:transparent; }
.side{ display:flex; gap:14px; margin-top:14px; flex-wrap:wrap; align-items:stretch; }
.chat{ flex:1; min-width:min(100%, 240px); background:var(--panel); border:1px solid var(--border);
  border-radius:12px; display:flex; flex-direction:column; max-height:220px; overflow:hidden;
  margin-top:14px; min-width:0; max-width:100%; }
.chat-head{ font-size:11.5px; font-weight:700; letter-spacing:.04em; color:var(--dim);
  padding:10px 12px; border-bottom:1px solid var(--border); text-transform:uppercase; flex-shrink:0; }
.chat-log{ flex:1; overflow-y:auto; padding:10px 12px; font-family:var(--mono); font-size:12.5px;
  display:flex; flex-direction:column; gap:6px; min-height:80px; -webkit-overflow-scrolling:touch; }
.chat-line{ color:var(--text); word-break:break-word; line-height:1.35; }
.chat-line .who{ color:var(--cyan); font-weight:600; }
.chat-line.mine .who{ color:var(--violet); }
.chat-line .msg{ color:var(--text); }
.chat-empty{ color:var(--faint); font-size:12px; font-family:var(--sans); }
.chat-form{ display:flex; gap:8px; padding:10px; border-top:1px solid var(--border);
  flex-shrink:0; background:var(--panel); position:sticky; bottom:0;
  padding-bottom:max(10px, env(safe-area-inset-bottom, 0px)); }
.chat-form input{ flex:1; min-width:0; font-size:16px; }
.chat-form button{ flex-shrink:0; min-height:var(--touch); }

/* Tablet */
@media (max-width: 900px){
  :root{ --app-pad-x:16px; --app-pad-y:18px; }
  .app{ max-width:100%; }
  .term-body{ height:50vh; height:50dvh; }
  .chat{ max-height:260px; }
}

/* Phone — stack, larger hit targets, collapsible presence roster */
@media (max-width: 639px){
  :root{ --app-pad-x:12px; --app-pad-y:12px; }
  .topbar{ padding-bottom:12px; margin-bottom:12px; gap:8px; align-items:flex-start; }
  .brand{ font-size:15px; }
  .brand span{ display:inline; margin-left:6px; font-size:11.5px; }
  .p2p{ font-size:11px; padding:8px 12px; white-space:normal; line-height:1.3; }
  .meta{ gap:8px; margin-bottom:10px; }
  .badge{ padding:8px 12px; min-height:36px; }
  .presence.toggleable{ border:1px solid var(--border); border-radius:999px; padding:8px 12px;
    min-height:36px; display:inline-flex; align-items:center; flex-wrap:wrap; gap:2px;
    background:var(--panel); max-width:100%; }
  .presence:not(.expanded) .names{ display:none; }
  .presence.expanded{ border-radius:12px; width:100%; }
  .presence.expanded .names{ display:inline; }
  .term{ min-height:220px; border-radius:10px; }
  .term-body{ height:42vh; height:42dvh; min-height:200px; }
  .chrome{ padding:8px 10px; }
  .font-btn{ min-height:36px; min-width:36px; padding:6px 10px; font-size:13px; }
  .panel{ padding:14px; }
  .row{ flex-direction:column; }
  .row input, .row button{ width:100%; min-width:0; min-height:var(--touch); }
  .input-row{ flex-direction:column; }
  .input-row input, .input-row button{ width:100%; min-height:var(--touch); }
  button{ min-height:var(--touch); }
  .chat{ max-height:none; min-height:200px; flex:1 1 auto; }
  .chat-log{ min-height:120px; max-height:40vh; }
  .chat-form button{ min-width:72px; }
}

/* Very small phones */
@media (max-width: 380px){
  .term-body{ height:38vh; height:38dvh; min-height:180px; }
  .p2p{ font-size:10.5px; }
}
${extraCss}`;
}

/** Inline <script> tags that load xterm + FitAddon onto globalThis (UMD). */
export function xtermScriptTags(): string {
  return `<script>${XTERM_JS}</script>\n<script>${XTERM_FIT_JS}</script>`;
}

/**
 * Browser JS that creates a Terminal, handles raw/resize/text feed entries,
 * and exposes `window.__vsTerm` helpers used by both page shells.
 *
 * Fit approach: FitAddon measures the `.term-body` container and resizes cols/rows.
 * Re-fit is debounced (100ms) on window resize + orientationchange so rapid
 * mobile viewport changes (URL bar show/hide, rotate) don't thrash layout.
 * Font size is user-controlled (A−/A+) and persisted in localStorage; changing
 * it triggers a re-fit so the terminal stays container-bound.
 */
export const XTERM_BOOT_JS = `
var __VS_FONT_KEY = "vibeshare-term-font-size";
var __VS_FONT_MIN = 10;
var __VS_FONT_MAX = 24;
var __VS_FONT_DEFAULT = 13;
function __vsB64ToBytes(s){
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function __vsLoadFontSize(){
  try {
    var n = parseInt(localStorage.getItem(__VS_FONT_KEY) || "", 10);
    if(n >= __VS_FONT_MIN && n <= __VS_FONT_MAX) return n;
  } catch(e){}
  return __VS_FONT_DEFAULT;
}
function __vsSaveFontSize(n){
  try { localStorage.setItem(__VS_FONT_KEY, String(n)); } catch(e){}
}
function __vsCreateTerm(el){
  var Terminal = (window.Terminal) || (window.xterm && window.xterm.Terminal);
  var FitAddonCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
  if(!Terminal) throw new Error("xterm.js failed to load");
  var fontSize = __vsLoadFontSize();
  var term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: fontSize,
    lineHeight: 1.2,
    theme: {
      background: "#0d0f14",
      foreground: "#edeef3",
      cursor: "#67e8f9",
      selectionBackground: "rgba(103,232,249,0.3)",
      black: "#0d0f14",
      red: "#ff8b85",
      green: "#7ee787",
      yellow: "#e3b341",
      blue: "#79c0ff",
      magenta: "#c4b5fd",
      cyan: "#67e8f9",
      white: "#edeef3",
      brightBlack: "#666c7c",
      brightRed: "#ffb1ac",
      brightGreen: "#a8f0b0",
      brightYellow: "#f0d78c",
      brightBlue: "#a5d6ff",
      brightMagenta: "#d8ccff",
      brightCyan: "#a5f3fc",
      brightWhite: "#ffffff"
    },
    allowProposedApi: true,
    scrollback: 5000
  });
  var fit = null;
  var fitTimer = null;
  function fitNow(){
    if(!fit) return;
    try { fit.fit(); } catch(e){}
  }
  function scheduleFit(){
    if(!fit) return;
    if(fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(function(){
      fitTimer = null;
      fitNow();
    }, 100);
  }
  if(FitAddonCtor){
    fit = new FitAddonCtor();
    term.loadAddon(fit);
  }
  term.open(el);
  if(fit){
    fitNow();
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("orientationchange", scheduleFit);
    if(window.visualViewport){
      window.visualViewport.addEventListener("resize", scheduleFit);
    }
  }
  function setFontSize(n){
    n = Math.max(__VS_FONT_MIN, Math.min(__VS_FONT_MAX, n|0));
    term.options.fontSize = n;
    __vsSaveFontSize(n);
    scheduleFit();
    return n;
  }
  function bumpFont(delta){
    var cur = term.options.fontSize || __VS_FONT_DEFAULT;
    return setFontSize(cur + (delta|0));
  }
  var api = {
    term: term,
    fit: fit,
    fitNow: fitNow,
    scheduleFit: scheduleFit,
    setFontSize: setFontSize,
    getFontSize: function(){ return term.options.fontSize || __VS_FONT_DEFAULT; },
    bumpFont: bumpFont
  };
  __vsWireFontControls(api);
  return api;
}
function __vsWireFontControls(termApi){
  if(!termApi || termApi._fontWired) return;
  termApi._fontWired = true;
  var dec = document.getElementById("fontDec");
  var inc = document.getElementById("fontInc");
  if(dec) dec.addEventListener("click", function(ev){
    ev.preventDefault();
    termApi.bumpFont(-1);
  });
  if(inc) inc.addEventListener("click", function(ev){
    ev.preventDefault();
    termApi.bumpFont(1);
  });
}
function __vsHandleEntry(termApi, entry){
  if(!termApi || !entry) return;
  var term = termApi.term;
  if(entry.type === "raw" && typeof entry.data === "string"){
    try {
      var bytes = __vsB64ToBytes(entry.data);
      term.write(bytes);
    } catch(e){}
    return;
  }
  if(entry.type === "resize" && entry.cols && entry.rows){
    try {
      var cols = Math.max(2, entry.cols|0);
      var rows = Math.max(1, entry.rows|0);
      if(term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    } catch(e){}
    return;
  }
  if(typeof entry.text === "string"){
    var prefix = "";
    if(entry.type === "milestone") prefix = "\\x1b[38;2;196;181;253m";
    else if(entry.type === "system") prefix = "\\x1b[38;2;102;108;124m\\x1b[3m";
    else if(entry.stream === "stderr") prefix = "\\x1b[38;2;154;160;178m";
    var suffix = prefix ? "\\x1b[0m" : "";
    term.writeln(prefix + entry.text + suffix);
  }
}
`;
