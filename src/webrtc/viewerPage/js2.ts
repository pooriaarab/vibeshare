// Inlined browser JS for viewerPage, part 2 of 5.
// Split verbatim from the original template literal — the concatenation
// in page.ts reproduces it byte for byte.
export const VIEWER_JS_PART_2 = `    var bin = atob(b64);
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
  // Host-provided STUN/TURN list (rtc-ice-servers, sent before the offer).
  // Null until it arrives — startPeer falls back to the default STUN then.
  var iceServers = null;
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
      id: id,`;
