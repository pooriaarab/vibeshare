// Inlined browser JS for the spectator page, part 2 of 4.
// Split verbatim from the original template literal.
export const SPECTATOR_JS_PART_2 = `    presenceLabel.setAttribute("aria-expanded", presenceExpanded ? "true" : "false");
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
    return btoa(bin);`;
