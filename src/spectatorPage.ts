/**
 * The web spectator view: a minimal, self-contained read-only client served
 * straight from the host machine — no install, no build, no external assets
 * (local-first holds for viewers too; the page phones nowhere).
 *
 * Two modes, same shell:
 *   - default (local loopback): plaintext SSE, JSON payloads
 *   - e2e (tunnel path): SSE data is base64(AES-GCM frame); the page decrypts
 *     with the key from `location.hash` via WebCrypto (mirrors viewerPage.ts)
 */
import type { Share } from './types.js';

/**
 * The shared terminal-view stylesheet: dark panel, mono feed, line classes
 * (`stderr` / `milestone` / `system`). Reused verbatim by the P2P viewer page
 * (`src/webrtc/viewerPage.ts`) so both views look and render the same.
 */
export const SPECTATOR_CSS = `:root{ --bg:#0a0b0f; --panel:#12141a; --panel-2:#171a22; --panel-3:#1d2129;
    --border:rgba(255,255,255,.08); --border-2:rgba(255,255,255,.14);
    --text:#edeef3; --dim:#9aa0b2; --faint:#666c7c; --cyan:#67e8f9;
    --violet:#c4b5fd; --green:#7ee787; --red:#ff8b85;
    --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--text); font-family:var(--sans);
    -webkit-font-smoothing:antialiased; min-height:100vh; }
  .app{ max-width:860px; margin:0 auto; padding:26px 22px 48px; }
  .topbar{ display:flex; align-items:center; justify-content:space-between; gap:14px;
    padding-bottom:18px; margin-bottom:20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .brand{ font-size:17px; font-weight:650; letter-spacing:-.01em; }
  .brand span{ color:var(--faint); font-size:12.5px; font-weight:450; margin-left:9px; }
  .p2p{ font-family:var(--mono); font-size:12px; color:var(--dim); background:var(--panel);
    border:1px solid var(--border-2); border-radius:999px; padding:6px 13px; white-space:nowrap; }
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
  .term{ background:#0d0f14; border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  .chrome{ display:flex; align-items:center; gap:6px; padding:10px 12px;
    background:var(--panel-2); border-bottom:1px solid var(--border); }
  .chrome span{ width:9px; height:9px; border-radius:50%; background:#3a3f4b; }
  .chrome .path{ margin-left:8px; font-family:var(--mono); font-size:11.5px; color:var(--faint);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .body{ font-family:var(--mono); font-size:13px; line-height:1.7; padding:14px 16px;
    min-height:280px; max-height:56vh; overflow-y:auto; }
  .line{ white-space:pre-wrap; word-break:break-word; }
  .line.stderr{ color:var(--dim); }
  .line.milestone{ color:var(--violet); }
  .line.system{ color:var(--faint); font-style:italic; }
  .panel{ background:var(--panel); border:1px solid var(--border); border-radius:12px;
    padding:18px; margin-bottom:16px; }
  .panel h1{ font-size:15px; margin:0 0 4px; }
  .panel p{ font-size:13px; color:var(--dim); margin:0 0 14px; }
  .row{ display:flex; gap:10px; flex-wrap:wrap; }
  input{ flex:1; min-width:160px; font-family:var(--mono); font-size:13px; color:var(--text);
    background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
  input:focus{ outline:none; border-color:var(--cyan); }
  .err{ color:var(--red); font-size:12.5px; margin-top:10px; display:none; }
  button{ font-family:inherit; font-size:13px; font-weight:600; color:var(--text);
    background:var(--panel-3); border:1px solid var(--border-2); border-radius:8px;
    padding:10px 16px; cursor:pointer; }
  button:hover{ background:#242933; }
  button:disabled{ opacity:.6; cursor:default; }
  .join-btn{ margin-top:14px; background:#3a3160; border-color:rgba(196,181,253,.5); color:#f2eeff; }
  .join-btn:hover{ background:#453a78; }
  .join-btn.pending{ background:var(--panel-3); border-color:var(--border-2); color:var(--dim); }
  .join-btn.joined{ background:rgba(126,231,135,.12); border-color:rgba(126,231,135,.4); color:var(--green); }
  .hidden{ display:none !important; }`;

export interface SpectatorPageOptions {
  /**
   * When true, the served page decrypts SSE payloads with WebCrypto AES-GCM
   * using the key from the URL `#fragment` (tunnel path). Default false —
   * plaintext SSE for the pure-local loopback path.
   */
  readonly e2e?: boolean;
}

export function spectatorPage(share: Share, opts: SpectatorPageOptions = {}): string {
  const e2e = opts.e2e === true;
  const config = JSON.stringify({
    id: share.id,
    name: share.name,
    access: share.access,
    e2e,
  }).replace(/</g, '\\u003c');

  const badgeLine = e2e
    ? '<div class="p2p"><b>●</b> tunnel · end-to-end encrypted</div>'
    : '<div class="p2p"><b>●</b> p2p · nothing stored on a server</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · ${escapeHtml(share.name)}</title>
<style>
  ${SPECTATOR_CSS}
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
      <input id="nameInput" placeholder="your name (optional)" maxlength="32">
      <input id="passInput" placeholder="passphrase" type="password" class="hidden">
      <button id="watchBtn">Watch</button>
    </div>
    <div class="err" id="joinErr"></div>
  </div>

  <div class="meta">
    <span class="badge" id="badge"><span class="d"></span> CONNECTING</span>
    <span class="count">👁 <b id="watching">0</b> watching</span>
  </div>

  <div class="term">
    <div class="chrome"><span></span><span></span><span></span><span class="path" id="chromePath"></span></div>
    <div class="body" id="termBody"></div>
  </div>

  <button class="join-btn hidden" id="reqBtn">Request to join</button>
</div>

<script>
(function(){
  "use strict";
  var CFG = ${config};
  var base = location.origin + "/s/" + CFG.id;
  var viewer = null, source = null;

  var joinPanel = document.getElementById("joinPanel");
  var joinErr = document.getElementById("joinErr");
  var passInput = document.getElementById("passInput");
  var badge = document.getElementById("badge");
  var watchingEl = document.getElementById("watching");
  var termBody = document.getElementById("termBody");
  var reqBtn = document.getElementById("reqBtn");

  document.getElementById("sessionName").textContent = " · " + CFG.name;
  document.getElementById("chromePath").textContent = CFG.name + " — live";

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function showErr(msg){ joinErr.textContent = msg; joinErr.style.display = "block"; }

  function line(cls, text){
    var d = document.createElement("div");
    d.className = "line " + cls;
    d.textContent = text;
    termBody.appendChild(d);
    while(termBody.childNodes.length > 800) termBody.removeChild(termBody.firstChild);
    termBody.scrollTop = termBody.scrollHeight;
  }

  // ---- optional e2e helpers (only when CFG.e2e). Key rides in #fragment.
  var cryptoKey = null;
  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64ToBytes(s){
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function decryptPayload(data){
    if(!cryptoKey) return Promise.resolve(null);
    var bytes;
    try { bytes = b64ToBytes(data); } catch(e){ return Promise.resolve(null); }
    if(bytes.length < 12 + 16) return Promise.resolve(null);
    var nonce = bytes.slice(0, 12);
    var ct = bytes.slice(12); // WebCrypto expects ciphertext‖tag concatenated
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, ct).then(function(plain){
      try { return JSON.parse(new TextDecoder().decode(plain)); } catch(e){ return null; }
    }).catch(function(){ return null; }); // GCM auth failure — drop, never render
  }
  if(CFG.e2e){
    var keyB64 = location.hash.slice(1);
    if(!keyB64){
      setBadge("ended", "MISSING KEY");
      showErr("This link is incomplete — the decryption key lives in the #fragment of the URL.");
    } else {
      crypto.subtle.importKey("raw", b64urlToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt"]).then(function(k){
        cryptoKey = k;
      }).catch(function(){
        setBadge("ended", "BAD KEY");
        showErr("The link's key fragment could not be imported as an AES-GCM key.");
      });
    }
  }

  function parseEventData(raw){
    if(CFG.e2e) return decryptPayload(raw);
    try { return Promise.resolve(JSON.parse(raw)); } catch(e){ return Promise.resolve(null); }
  }

  fetch(base + "/meta").then(function(r){ return r.json(); }).then(function(meta){
    if(meta.state !== "live"){ ended(meta.state); joinPanel.classList.add("hidden"); return; }
    if(meta.requiresPassphrase) passInput.classList.remove("hidden");
    watchingEl.textContent = meta.watching;
  }).catch(function(){ setBadge("ended", "UNREACHABLE"); });

  document.getElementById("watchBtn").addEventListener("click", function(){
    joinErr.style.display = "none";
    fetch(base + "/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: document.getElementById("nameInput").value, pass: passInput.value || undefined })
    }).then(function(r){
      if(r.status === 403){ passInput.classList.remove("hidden"); showErr("passphrase required or wrong — try again"); return null; }
      if(!r.ok){ showErr("could not join (" + r.status + ")"); return null; }
      return r.json();
    }).then(function(res){
      if(!res) return;
      viewer = res;
      joinPanel.classList.add("hidden");
      setBadge("", "SPECTATING · read-only");
      if(CFG.access === "invite") reqBtn.classList.remove("hidden");
      openStream();
    }).catch(function(){ showErr("could not reach the host"); });
  });

  function openStream(){
    source = new EventSource(base + "/stream?token=" + encodeURIComponent(viewer.token));
    source.addEventListener("entry", function(ev){
      parseEventData(ev.data).then(function(e){
        if(!e) return;
        var cls = e.type === "milestone" ? "milestone" : e.type === "system" ? "system" : (e.stream === "stderr" ? "stderr" : "");
        line(cls, e.text);
      });
    });
    source.addEventListener("viewers", function(ev){
      parseEventData(ev.data).then(function(d){ if(d) watchingEl.textContent = d.watching; });
    });
    source.addEventListener("join-approved", function(){
      setBadge("collab", "COLLABORATING · live");
      reqBtn.className = "join-btn joined"; reqBtn.disabled = true; reqBtn.textContent = "You’re in — live";
      line("system", "→ handed off: the host approved you as a collaborator.");
    });
    source.addEventListener("join-denied", function(){
      reqBtn.className = "join-btn"; reqBtn.disabled = false; reqBtn.textContent = "Request denied — try again";
    });
    source.addEventListener("kicked", function(){ source.close(); ended("kicked"); });
    source.addEventListener("ended", function(ev){
      source.close();
      parseEventData(ev.data).then(function(d){ ended(d && d.state ? d.state : "ended"); });
    });
    source.onerror = function(){ if(badge.className.indexOf("ended") === -1) setBadge("", "RECONNECTING…"); };
    source.onopen = function(){ if(!viewer || reqBtn.className.indexOf("joined") === -1) setBadge("", "SPECTATING · read-only"); };
  }

  reqBtn.addEventListener("click", function(){
    reqBtn.disabled = true; reqBtn.className = "join-btn pending"; reqBtn.textContent = "Waiting for host approval…";
    fetch(base + "/request-join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: viewer.token })
    }).then(function(r){
      if(!r.ok){ reqBtn.className = "join-btn"; reqBtn.disabled = false; reqBtn.textContent = "Request to join"; }
    }).catch(function(){ reqBtn.className = "join-btn"; reqBtn.disabled = false; });
  });

  function ended(state){
    setBadge("ended", state === "kicked" ? "REMOVED BY HOST" : "SHARE ENDED");
    reqBtn.classList.add("hidden");
    line("system", state === "kicked" ? "— the host removed you from this share —" : "— the host ended this share —");
  }

  window.addEventListener("beforeunload", function(){
    if(viewer && navigator.sendBeacon) navigator.sendBeacon(base + "/leave?token=" + encodeURIComponent(viewer.token), "");
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
