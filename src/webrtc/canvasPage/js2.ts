export const CANVAS_JS_PART_2 = `  /**
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
`;
