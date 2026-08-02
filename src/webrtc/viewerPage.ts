/**
 * The browser spectator/collaborator page for `--public` shares, served by
 * the signaling Worker at `/vibeshare/s/<id>` (see `worker/src/index.ts`).
 *
 * Self-contained and CSP-safe: no external scripts, styles, or fonts — the
 * page phones nowhere except the signaling ws on its own origin and the
 * peer-to-peer DataChannel to the host. Trust model:
 *
 *   - the AES-256-GCM key comes from `location.hash` ONLY (URL fragments are
 *     never sent to any server — the Worker never sees the key),
 *   - the Worker assigns the viewerId; the page runs the WebRTC ANSWER flow
 *     with the native browser `RTCPeerConnection`,
 *   - every DataChannel frame is decrypted with WebCrypto using the slice-1
 *     wire format `nonce(12) ‖ ciphertext ‖ tag(16)`,
 *   - collaborator input carries a per-peer monotonic `seq` INSIDE the
 *     encrypted payload (the host drops replays; see `transport.ts`),
 *   - presence + chat + annotations ride the Worker multi-party hub (NOT the
 *     DataChannel): chat/annotation TEXT is e2e-encrypted with the share key
 *     so the Worker relays ciphertext only; sender identity is stamped by the
 *     Worker from the connection (never trusted from the payload). Display
 *     text is sanitized client-side against terminal/bidi injection (mirrors
 *     vibe-core sanitizePeerText). Annotations are pinned comments anchored
 *     to the feed seq the viewer is watching, threaded via replyTo.
 *
 * Terminal rendering uses the same inlined xterm.js bootstrap as the local
 * spectator page so raw PTY bytes reconstruct the real TUI on both transports.
 */
import { XTERM_BOOT_JS, xtermPageStyles, xtermScriptTags } from '../xtermClient.js';

export function viewerPage(): string {
  return `<!DOCTYPE html>
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
${XTERM_BOOT_JS}
(function(){
  "use strict";

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
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var badge = document.getElementById("badge");
  var termBody = document.getElementById("termBody");
  var cmdInput = document.getElementById("cmdInput");
  var sendBtn = document.getElementById("sendBtn");
  var namePanel = document.getElementById("namePanel");
  var nameInput = document.getElementById("nameInput");
  var joinBtn = document.getElementById("joinBtn");
  var watchingEl = document.getElementById("watching");
  var presenceLabel = document.getElementById("presenceLabel");
  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatSend = document.getElementById("chatSend");
  var chatForm = document.getElementById("chatForm");

  var reqBtn = document.getElementById("reqBtn");
  var canDrive = false;
  var dcOpen = false;  var termApi = null;
  var lastEntrySeq = 0;
  var myViewerId = null;
  var myName = "";
  var joined = false;
  var chatEmpty = true;
  var annLog = document.getElementById("annLog");
  var annInput = document.getElementById("annInput");
  var annSend = document.getElementById("annSend");
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

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function fatal(msg){
    document.getElementById("errText").textContent = msg;
    document.getElementById("errPanel").classList.remove("hidden");
    namePanel.classList.add("hidden");
    setBadge("ended", "UNAVAILABLE");
  }
  function ensureTerm(){
    if(termApi) return termApi;
    termApi = __vsCreateTerm(termBody);
    return termApi;
  }
  function exportBaseName(){
    var n = shareId ? String(shareId) : "session";
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
  function applyEntry(entry){
    if(!entry) return;
    if(typeof entry.seq === "number"){
      if(entry.seq <= lastEntrySeq) return;
      lastEntrySeq = entry.seq;
      // termApi may not exist on the very first entry — noteSeqLine guards.
      noteSeqLine(entry.seq);
    }
    __vsHandleEntry(ensureTerm(), entry);
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

  // ---- share id from the path, key from the fragment (never sent anywhere)
  var idMatch = /\\/s\\/([A-Za-z0-9_-]+)/.exec(location.pathname);
  var shareId = idMatch ? idMatch[1] : null;
  if(!shareId){ fatal("This link has no share id."); return; }
  document.getElementById("shareLabel").textContent = " · " + shareId;
  document.getElementById("chromePath").textContent = shareId + " — live";

  var keyB64 = location.hash.slice(1);
  if(!keyB64){ fatal("This link is incomplete — the decryption key lives in the #fragment of the URL. Ask the host for the full link."); return; }

  // Build-a-grid entry: open the multi-view page with this share prefilled.
  // shareId + key are already URL-safe base64url — keep the fragment form raw.
  var gridLink = document.getElementById("gridLink");
  if(gridLink){
    gridLink.href = "/vibeshare/grid#" + shareId + "~" + keyB64;
    gridLink.classList.remove("hidden");
  }

  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes){
    var bin = "";
    for(var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(s){
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var keyPromise;
  try {
    keyPromise = crypto.subtle.importKey("raw", b64urlToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
  } catch(e) {
    fatal("The link's key fragment is not valid base64url.");
    return;
  }

  // ---- signaling: the Worker assigns our viewerId and relays handshake + presence/chat
  var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/vibeshare/ws/viewer?share=" + encodeURIComponent(shareId);
  var ws = new WebSocket(wsUrl);
  var pc = null, dc = null, key = null;
  var remoteDescSet = false;
  var iceQueue = [];
  var inputSeq = 0;      // per-peer monotonic, inside the encrypted payload
  var pendingHello = null;

  function send(obj){ if(ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  var presenceExpanded = false;
  presenceLabel.addEventListener("click", function(){
    presenceExpanded = !presenceExpanded;
    if(presenceExpanded) presenceLabel.classList.add("expanded");
    else presenceLabel.classList.remove("expanded");
    presenceLabel.setAttribute("aria-expanded", presenceExpanded ? "true" : "false");
  });

  function renderPresence(viewers){
    if(!Array.isArray(viewers)) return;
    var names = [];
    var count = 0;
    for(var i = 0; i < viewers.length; i++){
      var v = viewers[i];
      if(!v || typeof v.name !== "string") continue;
      var n = sanitizePeerText(v.name, 32).trim() || "viewer";
      if(v.role === "viewer") count++;
      names.push(escapeHtml(n) + (v.role === "host" ? " (host)" : ""));
    }
    watchingEl.textContent = String(count);
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

  function appendChat(frame){
    if(!frame) return;
    var name = sanitizePeerText(frame.name || "viewer", 32).trim() || "viewer";
    var mine = myViewerId && frame.viewerId === myViewerId;
    function show(text){
      if(chatEmpty){ chatLog.innerHTML = ""; chatEmpty = false; }
      var line = document.createElement("div");
      line.className = "chat-line" + (mine ? " mine" : "");
      line.innerHTML = '<span class="who">' + escapeHtml(name) + '</span>: <span class="msg">' + escapeHtml(text) + "</span>";
      chatLog.appendChild(line);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
    // Decrypt ciphertext with the share key; Worker never saw plaintext.
    if(!key || typeof frame.text !== "string") return;
    var bytes;
    try { bytes = b64ToBytes(frame.text); } catch(e){ return; }
    if(bytes.length < 12 + 16) return;
    var nonce = bytes.slice(0, 12);
    var ct = bytes.slice(12);
    crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct).then(function(plain){
      var text = sanitizePeerText(new TextDecoder().decode(plain), 500);
      if(text.length > 0) show(text);
    }).catch(function(){ /* GCM auth failure — drop */ });
  }

  function enableChat(){
    chatInput.disabled = false;
    chatSend.disabled = false;
    annInput.disabled = false;
    annSend.disabled = false;
  }

  // ---- annotations: pinned comments anchored to a feed seq (threaded).
  // Same hub + e2e rules as chat; the Worker stamps identity, mints the id.
  function onAnnotation(frame){
    if(!frame || !key || typeof frame.text !== "string") return;
    var bytes;
    try { bytes = b64ToBytes(frame.text); } catch(e){ return; }
    if(bytes.length < 12 + 16) return;
    var nonce = bytes.slice(0, 12);
    var ct = bytes.slice(12);
    crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct).then(function(plain){
      var text = sanitizePeerText(new TextDecoder().decode(plain), 500);
      if(text.length > 0) addAnn(frame, text, !!(myViewerId && frame.viewerId === myViewerId));
    }).catch(function(){ /* GCM auth failure — drop */ });
  }

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
    annInput.placeholder = "pin a comment at seq " + lastEntrySeq + "…";
    annInput.focus();
  });

  ws.onmessage = function(ev){
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(!msg || typeof msg.kind !== "string") return;
    if(msg.kind === "assigned"){
      myViewerId = msg.viewerId;
      if(joined) startPeer();
    } else if(msg.kind === "rtc-offer"){
      onOffer(msg.sdp);
    } else if(msg.kind === "rtc-ice"){
      onRemoteIce(msg.candidate, msg.mid);
    } else if(msg.kind === "presence"){
      renderPresence(msg.viewers);
    } else if(msg.kind === "chat"){
      appendChat(msg);
    } else if(msg.kind === "annotation"){
      onAnnotation(msg);
    } else if(msg.kind === "role-update"){
      onRoleUpdate(msg);
    }
  };
  ws.onopen = function(){
    if(pendingHello){ send(pendingHello); pendingHello = null; }
  };
  ws.onclose = function(ev){
    if(ev.code === 1012) ended("SHARE ENDED", "— the host ended this share —");
    else if(badge.className.indexOf("ended") === -1) setBadge("ended", "OFFLINE");
  };
  ws.onerror = function(){ setBadge("ended", "OFFLINE"); };

  joinBtn.addEventListener("click", function(){
    if(joined) return;
    joined = true;
    myName = sanitizePeerText(nameInput.value || "", 32).trim();
    if(!myName) myName = "viewer";
    namePanel.classList.add("hidden");
    var hello = { kind: "hello", name: myName };
    if(ws.readyState === 1) send(hello);
    else pendingHello = hello;
    if(myViewerId) startPeer();
    enableChat();
    reqBtn.classList.remove("hidden");
    pinBtn.classList.remove("hidden");
    setBadge("", "CONNECTING · waiting for host");
  });

  function setDriveEnabled(on){
    canDrive = !!on;
    var ready = canDrive && dcOpen;
    cmdInput.disabled = !ready;
    sendBtn.disabled = !ready;
    if(canDrive){
      setBadge("collab", "COLLABORATING · you can drive");
      reqBtn.className = "join-btn joined";
      reqBtn.disabled = true;
      reqBtn.textContent = "You're in — driving";
    }
  }

  function onRoleUpdate(msg){
    if(!msg) return;
    if(msg.role === "collaborator" && msg.joinRequest === "approved"){
      setDriveEnabled(true);
      applyEntry({ type: "system", text: "→ the host approved you — your keystrokes drive the session." });
    } else if(msg.joinRequest === "denied"){
      canDrive = false;
      cmdInput.disabled = true;
      sendBtn.disabled = true;
      reqBtn.className = "join-btn";
      reqBtn.disabled = false;
      reqBtn.textContent = "Request denied — try again";
      setBadge("", "LIVE · p2p · read-only");
    }
  }

  reqBtn.addEventListener("click", function(){
    if(ws.readyState !== 1) return;
    reqBtn.disabled = true;
    reqBtn.className = "join-btn pending";
    reqBtn.textContent = "Waiting for host approval…";
    // Identity is stamped by the Worker from the connection — never claim viewerId.
    send({ kind: "join-request" });
  });

  function startPeer(){
    if(pc) return;
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = function(ev){
      if(ev.candidate) send({ kind: "rtc-ice", candidate: ev.candidate.candidate, mid: ev.candidate.sdpMid || "0" });
    };
    pc.ondatachannel = function(ev){
      dc = ev.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = function(){
        dcOpen = true;
        setBadge("", canDrive ? "COLLABORATING · you can drive" : "LIVE · p2p · read-only");
        // Input stays disabled until the host approves (role-update).
        cmdInput.disabled = !canDrive;
        sendBtn.disabled = !canDrive;
        ensureTerm();
      };
      dc.onclose = function(){ ended("SHARE ENDED", "— the host ended this share —"); };
      dc.onmessage = function(mev){ onFrame(mev.data); };
    };
    pc.onconnectionstatechange = function(){
      if(pc.connectionState === "failed" || pc.connectionState === "closed") ended("DISCONNECTED", "— connection to the host was lost —");
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
    }).catch(function(){ setBadge("ended", "HANDSHAKE FAILED"); });
  }

  function onRemoteIce(candidate, mid){
    if(!pc) return;
    var c = { candidate: candidate, sdpMid: mid };
    if(remoteDescSet) pc.addIceCandidate(c).catch(function(){});
    else iceQueue.push(c);
  }

  // ---- DataChannel frames: nonce(12) ‖ ciphertext ‖ tag(16), AES-256-GCM
  function onFrame(data){
    if(!key) return;
    var bytes = new Uint8Array(data);
    if(bytes.length < 12 + 16) return;
    var nonce = bytes.slice(0, 12);
    var ct = bytes.slice(12); // WebCrypto expects ciphertext‖tag concatenated
    crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct).then(function(plain){
      var entry;
      try { entry = JSON.parse(new TextDecoder().decode(plain)); } catch(e){ return; }
      applyEntry(entry);
    }).catch(function(){
      // GCM auth failure: tampered frame — dropped, never rendered.
    });
  }

  // ---- collaborator input: {kind:'input', data, seq} encrypted host-bound.
  // Identity is the DataChannel peer (hub-stamped viewerId on the host side);
  // payload never carries viewerId. Enabled only after host role-update.
  function sendInputBytes(data){
    if(!canDrive || !data || !dc || dc.readyState !== "open" || !key) return;
    inputSeq++;
    var payload = new TextEncoder().encode(JSON.stringify({ kind: "input", data: data, seq: inputSeq }));
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload).then(function(ct){
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      try { dc.send(out.buffer); } catch(e){ /* channel closing */ }
    });
  }
  function sendInputLine(){
    var text = cmdInput.value;
    if(!text) return;
    cmdInput.value = "";
    // Append CR so Enter submits in shells/TUIs the way a real terminal does.
    sendInputBytes(text + "\\r");
  }
  sendBtn.addEventListener("click", sendInputLine);
  cmdInput.addEventListener("keydown", function(ev){
    if(!canDrive) return;
    if(ev.key === "Enter"){
      ev.preventDefault();
      sendInputLine();
      return;
    }
    // Control characters: Ctrl+C / Ctrl+D / Esc / Tab / arrows — send raw.
    if(ev.ctrlKey && ev.key.length === 1){
      ev.preventDefault();
      sendInputBytes(String.fromCharCode(ev.key.toUpperCase().charCodeAt(0) - 64));
      return;
    }
    if(ev.key === "Escape"){ ev.preventDefault(); sendInputBytes("\u001b"); return; }
    if(ev.key === "Tab"){ ev.preventDefault(); sendInputBytes("\t"); return; }
    if(ev.key === "Backspace"){ ev.preventDefault(); sendInputBytes("\u007f"); return; }
    if(ev.key === "ArrowUp"){ ev.preventDefault(); sendInputBytes("\u001b[A"); return; }
    if(ev.key === "ArrowDown"){ ev.preventDefault(); sendInputBytes("\u001b[B"); return; }
    if(ev.key === "ArrowRight"){ ev.preventDefault(); sendInputBytes("\u001b[C"); return; }
    if(ev.key === "ArrowLeft"){ ev.preventDefault(); sendInputBytes("\u001b[D"); return; }
  });

  // ---- chat: encrypt plaintext with share key; Worker stamps identity
  chatForm.addEventListener("submit", function(ev){
    ev.preventDefault();
    var text = sanitizePeerText(chatInput.value || "", 500).trim();
    if(!text || !key || ws.readyState !== 1) return;
    chatInput.value = "";
    var payload = new TextEncoder().encode(text);
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload).then(function(ct){
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      // Send ONLY ciphertext — never claim viewerId/name (Worker stamps them).
      send({ kind: "chat", text: bytesToB64(out) });
    });
  });

  // ---- annotations: pin a comment at the feed head (seq anchor), encrypted
  // like chat; the Worker stamps identity and mints the annotation id.
  annForm.addEventListener("submit", function(ev){
    ev.preventDefault();
    var text = sanitizePeerText(annInput.value || "", 500).trim();
    if(!text || !key || ws.readyState !== 1) return;
    annInput.value = "";
    var frame = { kind: "annotation", seq: lastEntrySeq, text: "" };
    if(annReplyTo) frame.replyTo = annReplyTo;
    setAnnReply(null);
    var payload = new TextEncoder().encode(text);
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload).then(function(ct){
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      // Send ONLY ciphertext + seq + replyTo — never claim identity.
      frame.text = bytesToB64(out);
      send(frame);
    });
  });

  function ended(state, msg){
    setBadge("ended", state);
    canDrive = false;
    dcOpen = false;
    cmdInput.disabled = true;
    sendBtn.disabled = true;
    chatInput.disabled = true;
    chatSend.disabled = true;
    annInput.disabled = true;
    annSend.disabled = true;
    reqBtn.disabled = true;
    applyEntry({ type: "system", text: msg });
  }

  keyPromise.then(function(k){
    key = k;
    setBadge("", "CONNECTING · enter a name to watch");
  }).catch(function(){
    fatal("The link's key fragment could not be imported as an AES-GCM key.");
  });
})();
</script>
</body>
</html>`;
}
