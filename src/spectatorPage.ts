/**
 * The web spectator view: a minimal, self-contained read-only client served
 * straight from the host machine — no install, no build, no external assets
 * (local-first holds for viewers too; the page phones nowhere).
 *
 * Two modes, same shell:
 *   - default (local loopback): plaintext SSE, JSON payloads
 *   - e2e (tunnel path): SSE data is base64(AES-GCM frame); the page decrypts
 *     with the key from `location.hash` via WebCrypto (mirrors viewerPage.ts)
 *
 * Terminal rendering uses inlined xterm.js (CSP-safe, no CDN) so raw PTY
 * bytes reconstruct colors/cursor/full-screen TUI redraws faithfully.
 */
import type { Share } from './types.js';
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from './xtermClient.js';

/**
 * @deprecated Prefer the shared xterm chrome via `xtermPageStyles()`. Kept as
 * a named export so existing importers (viewerPage, tests) keep compiling;
 * content now matches the xterm-era shell.
 */
export const SPECTATOR_CSS = xtermPageStyles();

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
    <div class="term-body" id="termBody"></div>
  </div>

  <button class="join-btn hidden" id="reqBtn">Request to join</button>
</div>

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}
(function(){
  "use strict";
  var CFG = ${config};
  var base = location.origin + "/s/" + CFG.id;
  var viewer = null, source = null;
  var termApi = null;
  var lastSeq = 0;

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

  function ensureTerm(){
    if(termApi) return termApi;
    termApi = __vsCreateTerm(termBody);
    return termApi;
  }

  function applyEntry(e){
    if(!e) return;
    if(typeof e.seq === "number"){
      if(e.seq <= lastSeq) return;
      lastSeq = e.seq;
    }
    __vsHandleEntry(ensureTerm(), e);
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
      ensureTerm();
      openStream();
    }).catch(function(){ showErr("could not reach the host"); });
  });

  function openStream(){
    source = new EventSource(base + "/stream?token=" + encodeURIComponent(viewer.token));
    source.addEventListener("entry", function(ev){
      parseEventData(ev.data).then(function(e){ applyEntry(e); });
    });
    source.addEventListener("viewers", function(ev){
      parseEventData(ev.data).then(function(d){ if(d) watchingEl.textContent = d.watching; });
    });
    source.addEventListener("join-approved", function(){
      setBadge("collab", "COLLABORATING · live");
      reqBtn.className = "join-btn joined"; reqBtn.disabled = true; reqBtn.textContent = "You’re in — live";
      applyEntry({ type: "system", text: "→ handed off: the host approved you as a collaborator." });
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
    applyEntry({ type: "system", text: state === "kicked" ? "— the host removed you from this share —" : "— the host ended this share —" });
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
