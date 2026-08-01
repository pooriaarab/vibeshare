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
 * Presence + chat + annotations ride the host multi-party hub (SSE events +
 * POST /chat|/annotate):
 *   - presence roster replaces the bare "N watching" count with named watchers
 *   - chat TEXT is e2e-encrypted with the share key when e2e is on (tunnel);
 *     on pure-local plaintext path the host still stamps identity from the
 *     viewer token. Display text is sanitized against terminal/bidi injection.
 *   - annotations are pinned comments anchored to the feed seq the viewer is
 *     watching, threaded via replyTo; same stamping + e2e rules as chat.
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

  const chatHint = e2e
    ? 'Say hi — messages are end-to-end encrypted with the share key.'
    : 'Say hi — the host stamps who sent what.';

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

  <button class="join-btn hidden" id="reqBtn">Request to join</button>

  <div class="input-row hidden" id="inputRow">
    <input id="cmdInput" placeholder="type to drive the session" disabled autocomplete="off">
    <button id="sendBtn" disabled>Send</button>
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
${XTERM_BOOT_JS}
(function(){
  "use strict";
  var CFG = ${config};
  var base = location.origin + "/s/" + CFG.id;
  var viewer = null, source = null;
  var termApi = null;
  var lastSeq = 0;
  var chatEmpty = true;
  var canDrive = false;
  var cmdInput = document.getElementById("cmdInput");
  var sendBtn = document.getElementById("sendBtn");
  var inputRow = document.getElementById("inputRow");

  // Mirror of vibe-core sanitizePeerText — peer display text is untrusted.
  var UNSAFE = /[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g;
  function sanitizePeerText(text, maxLen){
    if(typeof text !== "string") return "";
    var cleaned = text.replace(UNSAFE, "");
    if(typeof maxLen === "number" && cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen);
    return cleaned;
  }
  function escapeHtml(s){
    return String(s)
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;");
  }

  var joinPanel = document.getElementById("joinPanel");
  var joinErr = document.getElementById("joinErr");
  var passInput = document.getElementById("passInput");
  var badge = document.getElementById("badge");
  var watchingEl = document.getElementById("watching");
  var presenceLabel = document.getElementById("presenceLabel");
  var termBody = document.getElementById("termBody");
  var reqBtn = document.getElementById("reqBtn");
  var chatBox = document.getElementById("chatBox");
  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatForm = document.getElementById("chatForm");
  var annBox = document.getElementById("annBox");
  var annLog = document.getElementById("annLog");
  var annInput = document.getElementById("annInput");
  var annForm = document.getElementById("annForm");
  var annReplying = document.getElementById("annReplying");
  var annReplyingText = document.getElementById("annReplyingText");
  var pinBtn = document.getElementById("pinBtn");
  var anns = [];
  var annById = {};
  var annReplyTo = null;
  var annLocal = 0;
  // Best-effort seq → xterm buffer line map so a pin can "jump" to its moment.
  var seqLines = {};
  var seqLineQueue = [];

  document.getElementById("sessionName").textContent = " · " + CFG.name;
  document.getElementById("chromePath").textContent = CFG.name + " — live";

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function showErr(msg){ joinErr.textContent = msg; joinErr.style.display = "block"; }

  function ensureTerm(){
    if(termApi) return termApi;
    termApi = __vsCreateTerm(termBody);
    return termApi;
  }

  function exportBaseName(){
    var n = (CFG && CFG.name) ? String(CFG.name) : "session";
    n = n.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if(!n) n = "session";
    return "vibeshare-" + n + "-" + Date.now();
  }
  document.getElementById("exportPngBtn").addEventListener("click", function(){
    try { __vsExportPng(ensureTerm(), exportBaseName() + ".png"); } catch(e){}
  });
  document.getElementById("exportTextBtn").addEventListener("click", function(){
    try { __vsExportText(ensureTerm(), exportBaseName() + ".txt"); } catch(e){}
  });

  function applyEntry(e){
    if(!e) return;
    if(typeof e.seq === "number"){
      if(e.seq <= lastSeq) return;
      lastSeq = e.seq;
      // termApi may not exist on the very first entry — noteSeqLine guards.
      noteSeqLine(e.seq);
    }
    __vsHandleEntry(ensureTerm(), e);
  }

  function noteSeqLine(seq){
    try {
      if(!termApi || !termApi.term || !termApi.term.buffer) return;
      seqLines[seq] = termApi.term.buffer.active.length;
      seqLineQueue.push(seq);
      if(seqLineQueue.length > 4000){
        var old = seqLineQueue.shift();
        delete seqLines[old];
      }
    } catch(err){}
  }

  var presenceExpanded = false;
  presenceLabel.addEventListener("click", function(){
    presenceExpanded = !presenceExpanded;
    if(presenceExpanded) presenceLabel.classList.add("expanded");
    else presenceLabel.classList.remove("expanded");
    presenceLabel.setAttribute("aria-expanded", presenceExpanded ? "true" : "false");
  });

  function renderPresence(viewers, watchingFallback){
    var names = [];
    var count = 0;
    if(Array.isArray(viewers)){
      for(var i = 0; i < viewers.length; i++){
        var v = viewers[i];
        if(!v || typeof v.name !== "string") continue;
        var n = sanitizePeerText(v.name, 32).trim() || "viewer";
        if(v.role === "viewer" || v.role === "spectator" || v.role === "collaborator") count++;
        names.push(escapeHtml(n));
      }
    } else if(typeof watchingFallback === "number"){
      count = watchingFallback;
    }
    var label = '👁 <b id="watching">' + count + "</b> watching";
    if(names.length > 0){
      label += ' <span class="names">· ' + names.map(function(n){ return "<em>" + n + "</em>"; }).join(", ") + "</span>";
    }
    presenceLabel.innerHTML = label;
    if(presenceExpanded) presenceLabel.classList.add("expanded");
    else presenceLabel.classList.remove("expanded");
    presenceLabel.setAttribute("aria-expanded", presenceExpanded ? "true" : "false");
    watchingEl = document.getElementById("watching") || watchingEl;
  }

  function appendChatLine(name, text, mine){
    var safeName = sanitizePeerText(name || "viewer", 32).trim() || "viewer";
    var safeText = sanitizePeerText(text || "", 500);
    if(!safeText) return;
    if(chatEmpty){ chatLog.innerHTML = ""; chatEmpty = false; }
    var line = document.createElement("div");
    line.className = "chat-line" + (mine ? " mine" : "");
    line.innerHTML = '<span class="who">' + escapeHtml(safeName) + '</span>: <span class="msg">' + escapeHtml(safeText) + "</span>";
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---- annotations: pinned comments anchored to a feed seq (threaded).
  function addAnn(d, text, mine){
    var clean = sanitizePeerText(text, 500);
    if(!clean || !clean.trim()) return;
    var id = (typeof d.id === "string" && d.id) ? d.id : ("local-" + (++annLocal));
    if(annById[id]) return;
    var a = {
      id: id,
      seq: (typeof d.seq === "number" && isFinite(d.seq)) ? Math.max(0, Math.floor(d.seq)) : 0,
      name: sanitizePeerText(d.name || "viewer", 32).trim() || "viewer",
      text: clean,
      replyTo: (typeof d.replyTo === "string" && d.replyTo) ? d.replyTo : null,
      ts: (typeof d.ts === "number") ? d.ts : Date.now(),
      mine: !!mine
    };
    annById[id] = a;
    anns.push(a);
    if(anns.length > 500){
      var dropped = anns.shift();
      if(dropped) delete annById[dropped.id];
    }
    renderAnns();
  }

  function renderAnns(){
    annLog.innerHTML = "";
    var roots = [], repliesByParent = {}, i, a;
    for(i = 0; i < anns.length; i++){
      a = anns[i];
      if(a.replyTo && annById[a.replyTo]){
        (repliesByParent[a.replyTo] = repliesByParent[a.replyTo] || []).push(a);
      } else {
        roots.push(a);
      }
    }
    roots.sort(function(x, y){ return (x.seq - y.seq) || (x.ts - y.ts); });
    for(i = 0; i < roots.length; i++){
      appendAnnLine(roots[i], 0);
      var reps = repliesByParent[roots[i].id] || [];
      reps.sort(function(x, y){ return x.ts - y.ts; });
      for(var j = 0; j < reps.length; j++) appendAnnLine(reps[j], 1);
    }
    annLog.scrollTop = annLog.scrollHeight;
  }

  function appendAnnLine(a, depth){
    var line = document.createElement("div");
    line.className = "chat-line ann-line" + (a.mine ? " mine" : "") + (depth ? " reply" : "");
    var html = '<span class="seq">@' + a.seq + "</span> " +
      '<span class="who">' + escapeHtml(a.name) + "</span>: " +
      '<span class="msg">' + escapeHtml(a.text) + "</span>" +
      '<span class="ops">';
    if(typeof seqLines[a.seq] === "number"){
      html += '<a data-jump="' + a.seq + '">jump</a>';
    }
    html += '<a data-reply="' + a.id + '">reply</a></span>';
    line.innerHTML = html;
    annLog.appendChild(line);
  }

  annLog.addEventListener("click", function(ev){
    var t = ev.target;
    if(!t || !t.getAttribute) return;
    var jump = t.getAttribute("data-jump");
    if(jump !== null && jump !== undefined){
      ev.preventDefault();
      var lineNo = seqLines[Number(jump)];
      if(termApi && typeof lineNo === "number"){
        try { termApi.term.scrollToLine(Math.max(0, lineNo - 1)); } catch(e){}
      }
      return;
    }
    var rep = t.getAttribute("data-reply");
    if(rep){
      ev.preventDefault();
      setAnnReply(rep);
    }
  });

  function setAnnReply(id){
    annReplyTo = id || null;
    if(annReplyTo && annById[annReplyTo]){
      annReplyingText.textContent = "replying to " + annById[annReplyTo].name + " @" + annById[annReplyTo].seq;
      annReplying.classList.remove("hidden");
      annInput.focus();
    } else {
      annReplyTo = null;
      annReplying.classList.add("hidden");
    }
  }
  document.getElementById("annReplyCancel").addEventListener("click", function(){ setAnnReply(null); });

  pinBtn.addEventListener("click", function(){
    annInput.placeholder = "pin a comment at seq " + lastSeq + "…";
    annInput.focus();
  });

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
  function bytesToB64(bytes){
    var bin = "";
    for(var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
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
  function decryptChatCipher(cipherB64){
    if(!cryptoKey) return Promise.resolve(null);
    var bytes;
    try { bytes = b64ToBytes(cipherB64); } catch(e){ return Promise.resolve(null); }
    if(bytes.length < 12 + 16) return Promise.resolve(null);
    var nonce = bytes.slice(0, 12);
    var ct = bytes.slice(12);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, ct).then(function(plain){
      return sanitizePeerText(new TextDecoder().decode(plain), 500);
    }).catch(function(){ return null; });
  }
  function encryptChatPlain(text){
    if(!cryptoKey) return Promise.resolve(null);
    var payload = new TextEncoder().encode(text);
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, payload).then(function(ct){
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      return bytesToB64(out);
    });
  }
  if(CFG.e2e){
    var keyB64 = location.hash.slice(1);
    if(!keyB64){
      setBadge("ended", "MISSING KEY");
      showErr("This link is incomplete — the decryption key lives in the #fragment of the URL.");
    } else {
      crypto.subtle.importKey("raw", b64urlToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt", "encrypt"]).then(function(k){
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
    if(Array.isArray(meta.viewers)) renderPresence(meta.viewers, meta.watching);
    else if(typeof meta.watching === "number") renderPresence(null, meta.watching);
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
      chatBox.classList.remove("hidden");
      annBox.classList.remove("hidden");
      pinBtn.classList.remove("hidden");
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
      parseEventData(ev.data).then(function(d){
        if(!d) return;
        if(Array.isArray(d.viewers)) renderPresence(d.viewers, d.watching);
        else if(typeof d.watching === "number") renderPresence(null, d.watching);
      });
    });
    source.addEventListener("presence", function(ev){
      parseEventData(ev.data).then(function(d){
        if(d && Array.isArray(d.viewers)) renderPresence(d.viewers, d.watching);
      });
    });
    source.addEventListener("chat", function(ev){
      parseEventData(ev.data).then(function(d){
        if(!d) return;
        var mine = viewer && d.viewerId === viewer.viewerId;
        if(CFG.e2e && typeof d.text === "string"){
          // text is ciphertext; decrypt with share key
          decryptChatCipher(d.text).then(function(plain){
            if(plain) appendChatLine(d.name, plain, mine);
          });
        } else if(typeof d.text === "string"){
          appendChatLine(d.name, d.text, mine);
        }
      });
    });
    source.addEventListener("annotation", function(ev){
      parseEventData(ev.data).then(function(d){
        if(!d) return;
        var mine = viewer && d.viewerId === viewer.viewerId;
        if(CFG.e2e && typeof d.text === "string"){
          // text is ciphertext; decrypt with share key
          decryptChatCipher(d.text).then(function(plain){
            if(plain) addAnn(d, plain, mine);
          });
        } else if(typeof d.text === "string"){
          addAnn(d, d.text, mine);
        }
      });
    });
    source.addEventListener("join-approved", function(){
      setBadge("collab", "COLLABORATING · you can drive");
      reqBtn.className = "join-btn joined"; reqBtn.disabled = true; reqBtn.textContent = "You’re in — driving";
      canDrive = true;
      inputRow.classList.remove("hidden");
      cmdInput.disabled = false;
      sendBtn.disabled = false;
      applyEntry({ type: "system", text: "→ the host approved you — your keystrokes drive the session." });
    });
    source.addEventListener("join-denied", function(){
      canDrive = false;
      cmdInput.disabled = true;
      sendBtn.disabled = true;
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
      if(!r.ok){
        reqBtn.className = "join-btn"; reqBtn.disabled = false; reqBtn.textContent = "Request to join";
        if(r.status === 403) reqBtn.textContent = "This share is spectate-only";
      }
    }).catch(function(){ reqBtn.className = "join-btn"; reqBtn.disabled = false; });
  });

  // Collaborator input — identity from viewer token on the host; payload is just data.
  function postInput(data){
    if(!canDrive || !viewer || !data) return;
    fetch(base + "/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: viewer.token, data: data })
    }).catch(function(){ /* host gone */ });
  }
  function sendInputLine(){
    var text = cmdInput.value;
    if(!text) return;
    cmdInput.value = "";
    postInput(text + "\\r");
  }
  sendBtn.addEventListener("click", sendInputLine);
  cmdInput.addEventListener("keydown", function(ev){
    if(!canDrive) return;
    if(ev.key === "Enter"){ ev.preventDefault(); sendInputLine(); return; }
    if(ev.ctrlKey && ev.key.length === 1){
      ev.preventDefault();
      postInput(String.fromCharCode(ev.key.toUpperCase().charCodeAt(0) - 64));
      return;
    }
    if(ev.key === "Escape"){ ev.preventDefault(); postInput("\u001b"); return; }
    if(ev.key === "Tab"){ ev.preventDefault(); postInput("\t"); return; }
    if(ev.key === "Backspace"){ ev.preventDefault(); postInput("\u007f"); return; }
  });

  chatForm.addEventListener("submit", function(ev){
    ev.preventDefault();
    if(!viewer) return;
    var text = sanitizePeerText(chatInput.value || "", 500).trim();
    if(!text) return;
    chatInput.value = "";
    function post(body){
      return fetch(base + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    if(CFG.e2e){
      encryptChatPlain(text).then(function(cipher){
        if(!cipher) return;
        // ONLY ciphertext + token — host stamps identity from the token.
        return post({ token: viewer.token, text: cipher });
      });
    } else {
      post({ token: viewer.token, text: text });
    }
  });

  // Pin a comment at the feed head the viewer is watching (seq = anchor).
  // Identity rides the viewer token; replyTo threads under a parent pin.
  annForm.addEventListener("submit", function(ev){
    ev.preventDefault();
    if(!viewer) return;
    var text = sanitizePeerText(annInput.value || "", 500).trim();
    if(!text) return;
    annInput.value = "";
    var body = { token: viewer.token, seq: lastSeq, text: text };
    if(annReplyTo) body.replyTo = annReplyTo;
    setAnnReply(null);
    function post(b){
      return fetch(base + "/annotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b)
      });
    }
    if(CFG.e2e){
      encryptChatPlain(text).then(function(cipher){
        if(!cipher) return;
        body.text = cipher;
        return post(body);
      });
    } else {
      post(body).catch(function(){ /* host gone */ });
    }
  });

  function ended(state){
    setBadge("ended", state === "kicked" ? "REMOVED BY HOST" : "SHARE ENDED");
    reqBtn.classList.add("hidden");
    canDrive = false;
    cmdInput.disabled = true;
    sendBtn.disabled = true;
    inputRow.classList.add("hidden");
    chatInput.disabled = true;
    annInput.disabled = true;
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
