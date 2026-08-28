// Inlined browser JS for the spectator page, part 3 of 4.
// Split verbatim from the original template literal.
export const SPECTATOR_JS_PART_3 = `  }
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
      reqBtn.className = "join-btn joined"; reqBtn.disabled = true; reqBtn.textContent = "You’re in — driving";`;
