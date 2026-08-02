/**
 * Multi-view grid page — spectate several public shares side-by-side.
 *
 * Served by the signaling Worker at `GET /vibeshare/grid` (see
 * `worker/src/index.ts`). Share ids + AES keys live ONLY in the URL fragment:
 *
 *   /vibeshare/grid#<id1>~<key1>,<id2>~<key2>,…
 *
 * Fragments never reach the Worker. Each cell runs the same WebRTC ANSWER +
 * AES-256-GCM DataChannel path as `viewerPage.ts` (read-only spectate — no
 * drive/chat/annotations in v0). Terminal rendering reuses vibe-core/xterm
 * via the shared `__vs*` bootstrap.
 *
 * Self-contained and CSP-safe: inline script/style only, sockets + WebRTC
 * to the page origin, one viewer ws per cell against the existing share room.
 */
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from '../xtermClient.js';

/** One share slot decoded from the grid URL fragment. */
export interface GridShareRef {
  readonly id: string;
  /** base64url AES-256-GCM key (URL fragment form). */
  readonly key: string;
}

const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** base64url key material — 32 raw bytes → 43 chars without padding. */
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Parse a grid URL fragment (`#` optional) into share refs.
 * Invalid pairs are dropped; first occurrence of an id wins.
 */
export function parseGridFragment(fragment: string): GridShareRef[] {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return [];
  const out: GridShareRef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const tilde = part.indexOf('~');
    if (tilde <= 0) continue;
    const id = part.slice(0, tilde).trim();
    const key = part.slice(tilde + 1).trim();
    if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, key });
  }
  return out;
}

/** Serialize share refs back to a fragment body (no leading `#`). */
export function formatGridFragment(shares: readonly GridShareRef[]): string {
  return shares.map((s) => `${s.id}~${s.key}`).join(',');
}

/**
 * Pull `{id, key}` from a pasted single-share viewer URL or a bare `id~key`.
 * Accepts `/vibeshare/s/<id>#<key>`, `/s/<id>#<key>`, full origins, or `id~key`.
 */
export function parseSharePaste(input: string): GridShareRef | null {
  const text = input.trim();
  if (!text) return null;
  // Bare id~key (same as one fragment pair).
  const bare = parseGridFragment(text);
  if (bare.length === 1 && !text.includes('/') && !text.includes('#')) {
    return bare[0] ?? null;
  }
  let id: string | null = null;
  let key = '';
  try {
    // Absolute or path-absolute URL.
    const url = text.includes('://')
      ? new URL(text)
      : new URL(text, 'https://getvibe.dev');
    const m =
      /\/(?:vibeshare\/)?s\/([A-Za-z0-9_-]+)/.exec(url.pathname) ??
      /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    if (m) id = m[1] ?? null;
    key = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  } catch {
    // Fall through — try fragment-only paste of id~key with junk.
    const pair = parseGridFragment(text);
    return pair[0] ?? null;
  }
  if (!id || !key) return null;
  if (!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
  return { id, key };
}

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

export function gridPage(): string {
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
<body>
<div class="app grid-app">
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
  </div>
  <div class="grid-err" id="addErr" aria-live="polite"></div>

  <div class="grid-empty" id="emptyState">
    <strong>No sessions yet.</strong><br>
    Paste a vibeshare link above, or open this page as
    <code>/vibeshare/grid#id~key,id2~key2</code>.
  </div>

  <div class="grid" id="grid" hidden></div>
</div>

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}
(function(){
  "use strict";

  var SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

  var gridEl = document.getElementById("grid");
  var emptyEl = document.getElementById("emptyState");
  var addInput = document.getElementById("addInput");
  var addBtn = document.getElementById("addBtn");
  var addErr = document.getElementById("addErr");

  /** @type {Array<{id:string,key:string}>} */
  var shares = [];
  /** @type {Object.<string, any>} */
  var cells = {};
  var expandedId = null;
  var backdrop = null;

  function parseGridFragment(fragment){
    var raw = fragment.charAt(0) === "#" ? fragment.slice(1) : fragment;
    if(!raw) return [];
    var out = [];
    var seen = {};
    var parts = raw.split(",");
    for(var i = 0; i < parts.length; i++){
      var part = parts[i];
      var tilde = part.indexOf("~");
      if(tilde <= 0) continue;
      var id = part.slice(0, tilde).trim();
      var key = part.slice(tilde + 1).trim();
      if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
      if(seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, key: key });
    }
    return out;
  }

  function formatGridFragment(list){
    return list.map(function(s){ return s.id + "~" + s.key; }).join(",");
  }

  function parseSharePaste(input){
    var text = (input || "").trim();
    if(!text) return null;
    if(text.indexOf("/") === -1 && text.indexOf("#") === -1){
      var bare = parseGridFragment(text);
      return bare.length === 1 ? bare[0] : null;
    }
    var id = null;
    var key = "";
    try {
      var url = text.indexOf("://") !== -1 ? new URL(text) : new URL(text, location.origin);
      var m = /\\/(?:vibeshare\\/)?s\\/([A-Za-z0-9_-]+)/.exec(url.pathname);
      if(m) id = m[1];
      key = url.hash.charAt(0) === "#" ? url.hash.slice(1) : url.hash;
    } catch(e){
      var pair = parseGridFragment(text);
      return pair[0] || null;
    }
    if(!id || !key) return null;
    if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
    return { id: id, key: key };
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
    var body = formatGridFragment(shares);
    var next = body ? "#" + body : "";
    if(location.hash !== next){
      // replaceState keeps back-stack clean while still updating the fragment.
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
      gridEl.hidden = true;
    } else {
      emptyEl.hidden = true;
      gridEl.hidden = false;
    }
  }

  function setCellStatus(cell, state, label){
    cell.state = state;
    cell.dot.className = "cell-dot" + (state ? " " + state : "");
    cell.statusEl.textContent = label || state || "";
  }

  /**
   * Reuse the single-viewer WebRTC connect + e2e path per cell.
   * Same handshake as viewerPage: viewer ws → hello → ANSWER → AES-GCM DC.
   * Read-only: no input/chat/annotations.
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
        // Multi-cell: font hotkeys are global; re-fit this cell on create.
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
        // presence/chat/role-update ignored — grid is read-only spectate.
      };
      ws.onopen = function(){
        send({ kind: "hello", name: "grid" });
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

  function collapseExpanded(){
    if(!expandedId || !cells[expandedId]) {
      expandedId = null;
      if(backdrop){ try { backdrop.remove(); } catch(e){} backdrop = null; }
      document.body.classList.remove("grid-expanded");
      return;
    }
    var cell = cells[expandedId];
    cell.root.classList.remove("expanded");
    expandedId = null;
    if(backdrop){ try { backdrop.remove(); } catch(e){} backdrop = null; }
    document.body.classList.remove("grid-expanded");
    // Re-fit after layout settles.
    setTimeout(function(){ cell.conn.fit(); }, 50);
  }

  function expandCell(id){
    if(expandedId === id){ collapseExpanded(); return; }
    collapseExpanded();
    var cell = cells[id];
    if(!cell) return;
    expandedId = id;
    cell.root.classList.add("expanded");
    document.body.classList.add("grid-expanded");
    backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "expand-backdrop";
    backdrop.setAttribute("aria-label", "Close expanded session");
    backdrop.addEventListener("click", function(){ collapseExpanded(); });
    document.body.appendChild(backdrop);
    setTimeout(function(){ cell.conn.fit(); }, 50);
  }

  function removeShare(id, opts){
    opts = opts || {};
    if(expandedId === id) collapseExpanded();
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
      if(!opts.silent) setAddErr("Already in the grid: " + ref.id);
      return false;
    }
    shares.push({ id: ref.id, key: ref.key });
    if(!opts.skipHash) writeHash();
    syncEmpty();

    var root = document.createElement("div");
    root.className = "cell";
    root.dataset.shareId = ref.id;
    root.tabIndex = 0;
    root.setAttribute("role", "button");
    root.setAttribute("aria-label", "Session " + ref.id + " — click to expand");

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
    removeBtn.title = "Remove from grid";
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
    gridEl.appendChild(root);

    var cell = {
      root: root,
      body: body,
      dot: dot,
      statusEl: statusEl,
      state: "connecting",
      conn: null
    };

    function onStatus(state, label){ setCellStatus(cell, state, label); }

    cell.conn = connectShare(ref.id, ref.key, {
      getTermEl: function(){ return body; },
      onStatus: onStatus
    });
    cells[ref.id] = cell;

    root.addEventListener("click", function(ev){
      // Ignore clicks on the remove control (already stopPropagated).
      if(ev.target && ev.target.closest && ev.target.closest(".cell-remove")) return;
      expandCell(ref.id);
    });
    root.addEventListener("keydown", function(ev){
      if(ev.key === "Enter" || ev.key === " "){
        ev.preventDefault();
        expandCell(ref.id);
      } else if(ev.key === "Escape" && expandedId === ref.id){
        ev.preventDefault();
        collapseExpanded();
      }
    });

    return true;
  }

  function loadFromHash(){
    var next = parseGridFragment(location.hash || "");
    var nextIds = {};
    for(var i = 0; i < next.length; i++) nextIds[next[i].id] = true;
    Object.keys(cells).forEach(function(id){
      if(!nextIds[id]) removeShare(id, { skipHash: true });
    });
    shares = [];
    for(var j = 0; j < next.length; j++){
      var ref = next[j];
      if(cells[ref.id]){
        shares.push({ id: ref.id, key: ref.key });
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
    if(addShare(ref)){
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

  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape" && expandedId){
      ev.preventDefault();
      collapseExpanded();
    }
  });

  window.addEventListener("hashchange", function(){ loadFromHash(); });

  // Initial paint from fragment.
  loadFromHash();
})();
</script>
</body>
</html>`;
}
