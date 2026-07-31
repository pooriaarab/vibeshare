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
 *     encrypted payload (the host drops replays; see `transport.ts`).
 *
 * Terminal rendering and CSS are shared with the local spectator view
 * (`SPECTATOR_CSS`, same line classes) so local and public views look alike.
 */
import { SPECTATOR_CSS } from '../spectatorPage.js';

export function viewerPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibeshare · live</title>
<style>
  ${SPECTATOR_CSS}
  .input-row{ display:flex; gap:10px; margin-top:14px; }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">vibeshare<span id="shareLabel"></span></div>
    <div class="p2p"><b>●</b> p2p · end-to-end encrypted</div>
  </header>

  <div class="panel hidden" id="errPanel">
    <h1>Can't watch this share</h1>
    <p id="errText"></p>
  </div>

  <div class="meta">
    <span class="badge" id="badge"><span class="d"></span> CONNECTING</span>
    <span class="count" id="viewerIdLabel"></span>
  </div>

  <div class="term">
    <div class="chrome"><span></span><span></span><span></span><span class="path" id="chromePath"></span></div>
    <div class="body" id="termBody"></div>
  </div>

  <div class="input-row">
    <input id="cmdInput" placeholder="send input to the session (applied only if the host approved you)" disabled>
    <button id="sendBtn" disabled>Send</button>
  </div>
</div>

<script>
(function(){
  "use strict";

  var badge = document.getElementById("badge");
  var termBody = document.getElementById("termBody");
  var cmdInput = document.getElementById("cmdInput");
  var sendBtn = document.getElementById("sendBtn");

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function fatal(msg){
    document.getElementById("errText").textContent = msg;
    document.getElementById("errPanel").classList.remove("hidden");
    setBadge("ended", "UNAVAILABLE");
  }
  function line(cls, text){
    var d = document.createElement("div");
    d.className = "line " + cls;
    d.textContent = text;
    termBody.appendChild(d);
    while(termBody.childNodes.length > 800) termBody.removeChild(termBody.firstChild);
    termBody.scrollTop = termBody.scrollHeight;
  }

  // ---- share id from the path, key from the fragment (never sent anywhere)
  var idMatch = /\\/s\\/([A-Za-z0-9_-]+)/.exec(location.pathname);
  var shareId = idMatch ? idMatch[1] : null;
  if(!shareId){ fatal("This link has no share id."); return; }
  document.getElementById("shareLabel").textContent = " · " + shareId;
  document.getElementById("chromePath").textContent = shareId + " — live";

  var keyB64 = location.hash.slice(1);
  if(!keyB64){ fatal("This link is incomplete — the decryption key lives in the #fragment of the URL. Ask the host for the full link."); return; }

  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
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

  // ---- signaling: the Worker assigns our viewerId and relays the handshake
  var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/vibeshare/ws/viewer?share=" + encodeURIComponent(shareId);
  var ws = new WebSocket(wsUrl);
  var pc = null, dc = null, key = null;
  var remoteDescSet = false;
  var iceQueue = [];
  var inputSeq = 0;      // per-peer monotonic, inside the encrypted payload
  var lastEntrySeq = 0;  // render dedupe (backlog + live overlap)

  ws.onmessage = function(ev){
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(!msg || typeof msg.kind !== "string") return;
    if(msg.kind === "assigned"){
      document.getElementById("viewerIdLabel").textContent = "viewer " + msg.viewerId.slice(0, 8);
      startPeer();
    } else if(msg.kind === "rtc-offer"){
      onOffer(msg.sdp);
    } else if(msg.kind === "rtc-ice"){
      onRemoteIce(msg.candidate, msg.mid);
    }
    // anything else: the Worker relays only these kinds anyway — ignore.
  };
  ws.onclose = function(ev){
    if(ev.code === 1012) ended("SHARE ENDED", "— the host ended this share —");
    else if(badge.className.indexOf("ended") === -1) setBadge("ended", "OFFLINE");
  };
  ws.onerror = function(){ setBadge("ended", "OFFLINE"); };

  function send(obj){ if(ws.readyState === 1) ws.send(JSON.stringify(obj)); }

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
        setBadge("", "LIVE · p2p");
        cmdInput.disabled = false;
        sendBtn.disabled = false;
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
      if(typeof entry.seq === "number"){
        if(entry.seq <= lastEntrySeq) return;
        lastEntrySeq = entry.seq;
      }
      var cls = entry.type === "milestone" ? "milestone" : entry.type === "system" ? "system" : (entry.stream === "stderr" ? "stderr" : "");
      line(cls, entry.text);
    }).catch(function(){
      // GCM auth failure: tampered frame — dropped, never rendered.
    });
  }

  // ---- collaborator input: {kind:'input', data, seq} encrypted host-bound
  function sendInput(){
    var text = cmdInput.value;
    if(!text || !dc || dc.readyState !== "open" || !key) return;
    cmdInput.value = "";
    inputSeq++;
    var payload = new TextEncoder().encode(JSON.stringify({ kind: "input", data: text, seq: inputSeq }));
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload).then(function(ct){
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      dc.send(out.buffer);
    });
  }
  sendBtn.addEventListener("click", sendInput);
  cmdInput.addEventListener("keydown", function(ev){ if(ev.key === "Enter") sendInput(); });

  function ended(state, msg){
    setBadge("ended", state);
    cmdInput.disabled = true;
    sendBtn.disabled = true;
    line("system", msg);
  }

  keyPromise.then(function(k){
    key = k;
    setBadge("", "CONNECTING · waiting for host");
  }).catch(function(){
    fatal("The link's key fragment could not be imported as an AES-GCM key.");
  });
})();
</script>
</body>
</html>`;
}
