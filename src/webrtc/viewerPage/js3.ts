// Inlined browser JS for viewerPage, part 3 of 5.
// Split verbatim from the original template literal — the concatenation
// in page.ts reproduces it byte for byte.
export const VIEWER_JS_PART_3 = `      seq: (typeof d.seq === "number" && isFinite(d.seq)) ? Math.max(0, Math.floor(d.seq)) : 0,
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
    } else if(msg.kind === "rtc-ice-servers"){
      onIceServers(msg.iceServers);
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
    joined = true;`;
