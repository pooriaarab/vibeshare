/**
 * Multi-view canvas page — spatial alternative to the fixed grid.
 *
 * Served by the signaling Worker at `GET /vibeshare/canvas` (see
 * `worker/src/index.ts`). Same live-session cells as the grid, but each cell
 * is absolutely positioned on a pannable/zoomable board:
 *
 *   /vibeshare/canvas#<id1>~<key1>~<x1>~<y1>,<id2>~<key2>~<x2>~<y2>,…
 *
 * `x`,`y` are integer board coords; pairs without them auto-place. Fragments
 * never reach the Worker. Each cell reuses the EXACT WebRTC ANSWER +
 * AES-256-GCM DataChannel path as `gridPage.ts` (read-only spectate — no
 * drive/chat/annotations in v0). The per-cell `connectShare` below is copied
 * verbatim from gridPage; only the board container + pan/zoom/drag chrome is
 * canvas-specific.
 *
 * Self-contained and CSP-safe: inline script/style only, sockets + WebRTC
 * to the page origin, one viewer ws per cell against the existing share room.
 */
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from '../xtermClient.js';

/** One share slot decoded from the canvas URL fragment (with board position). */
export interface CanvasShareRef {
  readonly id: string;
  /** base64url AES-256-GCM key (URL fragment form). */
  readonly key: string;
  /** Integer board x (CSS px on the unscaled board). */
  readonly x: number;
  /** Integer board y (CSS px on the unscaled board). */
  readonly y: number;
}

const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** base64url key material — 32 raw bytes → 43 chars without padding. */
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Parse a canvas URL fragment (`#` optional) into positioned share refs.
 * Format: `id~key~x~y` pairs joined by `,`. Pairs without x/y auto-place at
 * (0,0). Invalid pairs (bad id/key, or x/y present but non-numeric) are
 * dropped; first occurrence of an id wins. Coordinates are parsed as ints
 * (truncated) — a present-but-NaN coordinate rejects the whole pair.
 */
export function parseCanvasFragment(fragment: string): CanvasShareRef[] {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return [];
  const out: CanvasShareRef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const segs = part.split('~');
    const id = (segs[0] ?? '').trim();
    const key = (segs[1] ?? '').trim();
    if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
    if (seen.has(id)) continue;
    let x = 0;
    let y = 0;
    if (segs.length >= 4) {
      const px = parseInt((segs[2] ?? '').trim(), 10);
      const py = parseInt((segs[3] ?? '').trim(), 10);
      // Reject NaN — a present-but-non-numeric coordinate is malformed.
      if (Number.isNaN(px) || Number.isNaN(py)) continue;
      x = px;
      y = py;
    }
    seen.add(id);
    out.push({ id, key, x, y });
  }
  return out;
}

/** Serialize positioned share refs back to a fragment body (no leading `#`). */
export function formatCanvasFragment(shares: readonly CanvasShareRef[]): string {
  return shares.map((s) => `${s.id}~${s.key}~${s.x}~${s.y}`).join(',');
}

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

export function canvasPage(): string {
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
<body>
<div class="app canvas-app">
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
</div>

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}
(function(){
  "use strict";

  var SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
  var MIN_ZOOM = 0.3, MAX_ZOOM = 2;

  var viewportEl = document.getElementById("viewport");
  var boardEl = document.getElementById("board");
  var emptyEl = document.getElementById("emptyState");
  var addInput = document.getElementById("addInput");
  var addBtn = document.getElementById("addBtn");
  var addErr = document.getElementById("addErr");
  var zoomInBtn = document.getElementById("zoomIn");
  var zoomOutBtn = document.getElementById("zoomOut");
  var zoomLabel = document.getElementById("zoomLabel");

  /** @type {Array<{id:string,key:string,x:number,y:number}>} */
  var shares = [];
  /** @type {Object.<string, any>} */
  var cells = {};

  // Board view state (pan in viewport px, zoom is unitless scale).
  var panX = 48, panY = 48, zoom = 1;

  function parseCanvasFragment(fragment){
    var raw = fragment.charAt(0) === "#" ? fragment.slice(1) : fragment;
    if(!raw) return [];
    var out = [];
    var seen = {};
    var parts = raw.split(",");
    for(var i = 0; i < parts.length; i++){
      var part = parts[i];
      var segs = part.split("~");
      var id = (segs[0] || "").trim();
      var key = (segs[1] || "").trim();
      if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
      if(seen[id]) continue;
      var x = 0, y = 0;
      if(segs.length >= 4){
        var px = parseInt((segs[2] || "").trim(), 10);
        var py = parseInt((segs[3] || "").trim(), 10);
        if(isNaN(px) || isNaN(py)) continue;
        x = px; y = py;
      }
      seen[id] = true;
      out.push({ id: id, key: key, x: x, y: y });
    }
    return out;
  }

  function formatCanvasFragment(list){
    return list.map(function(s){ return s.id + "~" + s.key + "~" + s.x + "~" + s.y; }).join(",");
  }

  function parseSharePaste(input){
    var text = (input || "").trim();
    if(!text) return null;
    if(text.indexOf("/") === -1 && text.indexOf("#") === -1){
      // Bare id~key (or id~key~x~y) — take the first canvas pair.
      var bare = parseCanvasFragment(text);
      return bare.length === 1 ? bare[0] : null;
    }
    var id = null, key = "";
    try {
      var url = text.indexOf("://") !== -1 ? new URL(text) : new URL(text, location.origin);
      var m = /\\/(?:vibeshare\\/)?s\\/([A-Za-z0-9_-]+)/.exec(url.pathname);
      if(m) id = m[1];
      key = url.hash.charAt(0) === "#" ? url.hash.slice(1) : url.hash;
    } catch(e){
      var pair = parseCanvasFragment(text);
      return pair[0] || null;
    }
    if(!id || !key) return null;
    if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
    return { id: id, key: key, x: 0, y: 0 };
  }

  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setAddErr(msg){ addErr.textContent = msg || ""; }

  function writeHash(){
    var body = formatCanvasFragment(shares);
    var next = body ? "#" + body : "";
    if(location.hash !== next){
      if(history.replaceState){
        history.replaceState(null, "", location.pathname + location.search + next);
      } else {
        location.hash = body;
      }
    }
  }

  function syncEmpty(){
    var n = shares.length;
    if(n === 0){
      emptyEl.hidden = false;
      viewportEl.hidden = true;
    } else {
      emptyEl.hidden = true;
      viewportEl.hidden = false;
    }
  }

  function applyTransform(){
    boardEl.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
    if(zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + "%";
  }

  // Zoom around a viewport-space point (cursor / control center) so the board
  // point under it stays fixed on screen.
  function setZoom(newZoom, originClientX, originClientY){
    var z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if(typeof originClientX === "number" && typeof originClientY === "number"){
      var rect = viewportEl.getBoundingClientRect();
      var cx = originClientX - rect.left;
      var cy = originClientY - rect.top;
      var bx = (cx - panX) / zoom;
      var by = (cy - panY) / zoom;
      panX = cx - bx * z;
      panY = cy - by * z;
    }
    zoom = z;
    applyTransform();
  }

  /**
   * Reuse the single-viewer WebRTC connect + e2e path per cell.
   * Same handshake as viewerPage / gridPage: viewer ws → hello → ANSWER →
   * AES-GCM DC. Read-only: no input/chat/annotations.
   */
  function connectShare(shareId, keyB64, hooks){
    var closed = false;
    var ws = null;
    var pc = null;
    var dc = null;
    var key = null;
    var myViewerId = null;
    var remoteDescSet = false;
    var iceQueue = [];
    var lastEntrySeq = 0;
    var termApi = null;

    function send(obj){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

    function ensureTerm(){
      if(termApi) return termApi;
      if(hooks.getTermEl){
        termApi = __vsCreateTerm(hooks.getTermEl());
        try { if(termApi.fitNow) termApi.fitNow(); } catch(e){}
      }
      return termApi;
    }

    function applyEntry(entry){
      if(!entry) return;
      if(typeof entry.seq === "number"){
        if(entry.seq <= lastEntrySeq) return;
        lastEntrySeq = entry.seq;
      }
      try { __vsHandleEntry(ensureTerm(), entry); } catch(e){}
    }

    function teardown(statusLabel){
      if(closed) return;
      closed = true;
      try { if(dc) dc.close(); } catch(e){}
      try { if(pc) pc.close(); } catch(e){}
      try { if(ws) ws.close(); } catch(e){}
      dc = null; pc = null; ws = null;
      if(hooks.onStatus) hooks.onStatus("dead", statusLabel || "OFFLINE");
    }

    function onFrame(data){
      if(!key) return;
      var bytes = new Uint8Array(data);
      if(bytes.length < 12 + 16) return;
      var nonce = bytes.slice(0, 12);
      var ct = bytes.slice(12);
      crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct).then(function(plain){
        var entry;
        try { entry = JSON.parse(new TextDecoder().decode(plain)); } catch(e){ return; }
        applyEntry(entry);
      }).catch(function(){ /* GCM auth failure — drop */ });
    }

    function startPeer(){
      if(pc || closed) return;
      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.onicecandidate = function(ev){
        if(ev.candidate) send({ kind: "rtc-ice", candidate: ev.candidate.candidate, mid: ev.candidate.sdpMid || "0" });
      };
      pc.ondatachannel = function(ev){
        dc = ev.channel;
        dc.binaryType = "arraybuffer";
        dc.onopen = function(){
          if(hooks.onStatus) hooks.onStatus("live", "LIVE");
          ensureTerm();
        };
        dc.onclose = function(){ teardown("ENDED"); };
        dc.onmessage = function(mev){ onFrame(mev.data); };
      };
      pc.onconnectionstatechange = function(){
        if(!pc) return;
        if(pc.connectionState === "failed" || pc.connectionState === "closed") teardown("DISCONNECTED");
      };
    }

    function onOffer(sdp){
      if(!pc) return;
      pc.setRemoteDescription({ type: "offer", sdp: sdp }).then(function(){
        remoteDescSet = true;
        for(var i = 0; i < iceQueue.length; i++) pc.addIceCandidate(iceQueue[i]).catch(function(){});
        iceQueue = [];
        return pc.createAnswer();
      }).then(function(answer){
        return pc.setLocalDescription(answer);
      }).then(function(){
        send({ kind: "rtc-answer", sdp: pc.localDescription.sdp });
      }).catch(function(){
        if(hooks.onStatus) hooks.onStatus("dead", "HANDSHAKE FAILED");
      });
    }

    function onRemoteIce(candidate, mid){
      if(!pc) return;
      var c = { candidate: candidate, sdpMid: mid };
      if(remoteDescSet) pc.addIceCandidate(c).catch(function(){});
      else iceQueue.push(c);
    }

    var keyPromise;
    try {
      keyPromise = crypto.subtle.importKey("raw", b64urlToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt"]);
    } catch(e) {
      if(hooks.onStatus) hooks.onStatus("dead", "BAD KEY");
      return { close: function(){}, fit: function(){} };
    }

    keyPromise.then(function(k){
      if(closed) return;
      key = k;
      var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host +
        "/vibeshare/ws/viewer?share=" + encodeURIComponent(shareId);
      ws = new WebSocket(wsUrl);
      ws.onmessage = function(ev){
        var msg;
        try { msg = JSON.parse(ev.data); } catch(e){ return; }
        if(!msg || typeof msg.kind !== "string") return;
        if(msg.kind === "assigned"){
          myViewerId = msg.viewerId;
          startPeer();
        } else if(msg.kind === "rtc-offer"){
          onOffer(msg.sdp);
        } else if(msg.kind === "rtc-ice"){
          onRemoteIce(msg.candidate, msg.mid);
        }
        // presence/chat/role-update ignored — canvas is read-only spectate.
      };
      ws.onopen = function(){
        send({ kind: "hello", name: "canvas" });
        if(myViewerId) startPeer();
        if(hooks.onStatus) hooks.onStatus("connecting", "CONNECTING");
      };
      ws.onclose = function(ev){
        if(ev.code === 1012) teardown("ENDED");
        else teardown("OFFLINE");
      };
      ws.onerror = function(){ if(hooks.onStatus) hooks.onStatus("dead", "OFFLINE"); };
    }).catch(function(){
      if(hooks.onStatus) hooks.onStatus("dead", "BAD KEY");
    });

    return {
      close: function(){ teardown("OFFLINE"); },
      fit: function(){
        try { if(termApi && termApi.fitNow) termApi.fitNow(); } catch(e){}
      },
      getTermApi: function(){ return termApi; }
    };
  }

  function setCellStatus(cell, state, label){
    cell.state = state;
    cell.dot.className = "cell-dot" + (state ? " " + state : "");
    cell.statusEl.textContent = label || state || "";
  }

  function placeCell(cell){
    cell.root.style.left = cell.x + "px";
    cell.root.style.top = cell.y + "px";
  }

  // Cascade new shares so they don't all stack at (0,0).
  function autoPosition(){
    var n = Object.keys(cells).length;
    return { x: 40 + (n % 3) * 60, y: 40 + Math.floor(n / 3) * 60 };
  }

  function removeShare(id, opts){
    opts = opts || {};
    var cell = cells[id];
    if(cell){
      try { cell.conn.close(); } catch(e){}
      try { cell.root.remove(); } catch(e){}
      delete cells[id];
    }
    shares = shares.filter(function(s){ return s.id !== id; });
    if(!opts.skipHash) writeHash();
    syncEmpty();
  }

  function addShare(ref, opts){
    opts = opts || {};
    if(!ref || !ref.id || !ref.key) return false;
    if(cells[ref.id]){
      if(!opts.silent) setAddErr("Already on the board: " + ref.id);
      return false;
    }
    var pos = (typeof ref.x === "number" && typeof ref.y === "number" && !opts.autoPlace)
      ? { x: ref.x, y: ref.y } : autoPosition();
    shares.push({ id: ref.id, key: ref.key, x: pos.x, y: pos.y });
    if(!opts.skipHash) writeHash();
    syncEmpty();

    var root = document.createElement("div");
    root.className = "cell";
    root.dataset.shareId = ref.id;

    var head = document.createElement("div");
    head.className = "cell-head";

    var dot = document.createElement("span");
    dot.className = "cell-dot connecting";
    dot.setAttribute("aria-hidden", "true");

    var idEl = document.createElement("span");
    idEl.className = "cell-id";
    idEl.textContent = ref.id;
    idEl.title = ref.id;

    var statusEl = document.createElement("span");
    statusEl.className = "cell-status";
    statusEl.textContent = "CONNECTING";

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cell-remove";
    removeBtn.title = "Remove from board";
    removeBtn.setAttribute("aria-label", "Remove " + ref.id);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      removeShare(ref.id);
    });

    head.appendChild(dot);
    head.appendChild(idEl);
    head.appendChild(statusEl);
    head.appendChild(removeBtn);

    var body = document.createElement("div");
    body.className = "cell-body";

    root.appendChild(head);
    root.appendChild(body);
    boardEl.appendChild(root);

    var cell = {
      root: root,
      body: body,
      dot: dot,
      statusEl: statusEl,
      state: "connecting",
      x: pos.x,
      y: pos.y,
      conn: null
    };
    placeCell(cell);

    // Drag the HEADER to reposition the cell in board space; persist on drop.
    startCellDrag(cell, head);

    function onStatus(state, label){ setCellStatus(cell, state, label); }
    cell.conn = connectShare(ref.id, ref.key, {
      getTermEl: function(){ return body; },
      onStatus: onStatus
    });
    cells[ref.id] = cell;

    return true;
  }

  function startCellDrag(cell, handle){
    handle.addEventListener("mousedown", function(ev){
      if(ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      var startMX = ev.clientX, startMY = ev.clientY;
      var startX = cell.x, startY = cell.y;
      cell.root.style.zIndex = 20;
      function move(e){
        // Convert screen-space delta to board space via the current zoom.
        cell.x = startX + (e.clientX - startMX) / zoom;
        cell.y = startY + (e.clientY - startMY) / zoom;
        placeCell(cell);
      }
      function up(){
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        cell.root.style.zIndex = "";
        cell.x = Math.round(cell.x);
        cell.y = Math.round(cell.y);
        placeCell(cell);
        for(var i = 0; i < shares.length; i++){
          if(shares[i].id === cell.root.dataset.shareId){
            shares[i].x = cell.x;
            shares[i].y = cell.y;
          }
        }
        writeHash();
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // Pan: drag the empty board background.
  viewportEl.addEventListener("mousedown", function(ev){
    if(ev.button !== 0) return;
    // Only pan when the press lands on the empty board/viewport (not a cell).
    if(ev.target && ev.target.closest && ev.target.closest(".cell")) return;
    ev.preventDefault();
    viewportEl.classList.add("panning");
    var startMX = ev.clientX, startMY = ev.clientY;
    var startPX = panX, startPY = panY;
    function move(e){
      panX = startPX + (e.clientX - startMX);
      panY = startPY + (e.clientY - startMY);
      applyTransform();
    }
    function up(){
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      viewportEl.classList.remove("panning");
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // Zoom: wheel over the viewport, anchored to the cursor.
  viewportEl.addEventListener("wheel", function(ev){
    ev.preventDefault();
    var delta = -ev.deltaY;
    if(ev.deltaMode === 1) delta *= 16; // DOM_DELTA_LINE → px-ish
    else if(ev.deltaMode === 2) delta *= 100; // DOM_DELTA_PAGE
    var factor = Math.exp(delta * 0.0015);
    setZoom(zoom * factor, ev.clientX, ev.clientY);
  }, { passive: false });

  if(zoomInBtn) zoomInBtn.addEventListener("click", function(){
    var rect = viewportEl.getBoundingClientRect();
    setZoom(zoom * 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  if(zoomOutBtn) zoomOutBtn.addEventListener("click", function(){
    var rect = viewportEl.getBoundingClientRect();
    setZoom(zoom / 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });

  function loadFromHash(){
    var next = parseCanvasFragment(location.hash || "");
    var nextIds = {};
    for(var i = 0; i < next.length; i++) nextIds[next[i].id] = true;
    Object.keys(cells).forEach(function(id){
      if(!nextIds[id]) removeShare(id, { skipHash: true });
    });
    shares = [];
    for(var j = 0; j < next.length; j++){
      var ref = next[j];
      if(cells[ref.id]){
        // Already on the board — just sync its position.
        var c = cells[ref.id];
        c.x = ref.x; c.y = ref.y;
        placeCell(c);
        shares.push({ id: ref.id, key: ref.key, x: ref.x, y: ref.y });
      } else {
        addShare(ref, { skipHash: true, silent: true });
      }
    }
    syncEmpty();
  }

  addBtn.addEventListener("click", function(){
    setAddErr("");
    var ref = parseSharePaste(addInput.value || "");
    if(!ref){
      setAddErr("Paste a full share link (…/s/<id>#<key>) or id~key.");
      return;
    }
    if(addShare(ref, { autoPlace: true })){
      addInput.value = "";
      setAddErr("");
    }
  });
  addInput.addEventListener("keydown", function(ev){
    if(ev.key === "Enter"){
      ev.preventDefault();
      addBtn.click();
    }
  });

  window.addEventListener("hashchange", function(){ loadFromHash(); });

  // Initial paint from fragment.
  applyTransform();
  loadFromHash();
})();
</script>
</body>
</html>`;
}
