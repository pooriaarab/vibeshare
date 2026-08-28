// Inlined browser JS for viewerPage, part 4 of 5.
// Split verbatim from the original template literal — the concatenation
// in page.ts reproduces it byte for byte.
export const VIEWER_JS_PART_4 = `    myName = sanitizePeerText(nameInput.value || "", 32).trim();
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

  // The host's ICE config (its own STUN/TURN, creds included) applies only if
  // it lands before the peer connection exists; sanitize before trusting it.
  function onIceServers(list){
    if(pc || !Array.isArray(list) || list.length === 0) return;
    var clean = [];
    for(var i = 0; i < list.length; i++){
      var s = list[i];
      if(!s || typeof s !== "object") continue;
      var urls = null;
      if(typeof s.urls === "string" && s.urls) urls = s.urls;
      else if(Array.isArray(s.urls)){
        urls = [];
        for(var j = 0; j < s.urls.length; j++){
          if(typeof s.urls[j] === "string" && s.urls[j]) urls.push(s.urls[j]);
        }
        if(urls.length === 0) urls = null;
      }
      if(!urls) continue;
      var entry = { urls: urls };
      if(typeof s.username === "string" && s.username) entry.username = s.username;
      if(typeof s.credential === "string" && s.credential) entry.credential = s.credential;
      clean.push(entry);
    }
    if(clean.length > 0) iceServers = clean;
  }

  function startPeer(){
    if(pc) return;
    pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
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

  // ---- DataChannel frames: nonce(12) ‖ ciphertext ‖ tag(16), AES-256-GCM`;
