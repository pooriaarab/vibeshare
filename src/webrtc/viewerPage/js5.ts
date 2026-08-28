// Inlined browser JS for viewerPage, part 5 of 5.
// Split verbatim from the original template literal — the concatenation
// in page.ts reproduces it byte for byte.
export const VIEWER_JS_PART_5 = `  function onFrame(data){
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
})();`;
