// Inlined browser JS for the spectator page, part 4 of 4.
// Split verbatim from the original template literal.
export const SPECTATOR_JS_PART_4 = `      canDrive = true;
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
})();`;
