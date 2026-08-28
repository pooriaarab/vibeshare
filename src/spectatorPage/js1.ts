// Inlined browser JS for the spectator page, part 1 of 4.
// Split verbatim from the original template literal. The share config is
// the only interpolation in the script body, so it is its own small
// function and everything after it is a plain constant.
export function SPECTATOR_JS_CONFIG(config: string): string {
  return `(function(){
  "use strict";
  var CFG = ${config};`;
}

export const SPECTATOR_JS_PART_1 = `  var base = location.origin + "/s/" + CFG.id;
  var viewer = null, source = null;
  var termApi = null;
  var lastSeq = 0;
  var chatEmpty = true;
  var canDrive = false;
  var cmdInput = document.getElementById("cmdInput");
  var sendBtn = document.getElementById("sendBtn");
  var inputRow = document.getElementById("inputRow");

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
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;");
  }

  var joinPanel = document.getElementById("joinPanel");
  var joinErr = document.getElementById("joinErr");
  var passInput = document.getElementById("passInput");
  var badge = document.getElementById("badge");
  var watchingEl = document.getElementById("watching");
  var presenceLabel = document.getElementById("presenceLabel");
  var termBody = document.getElementById("termBody");
  var reqBtn = document.getElementById("reqBtn");
  var chatBox = document.getElementById("chatBox");
  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatForm = document.getElementById("chatForm");
  var annBox = document.getElementById("annBox");
  var annLog = document.getElementById("annLog");
  var annInput = document.getElementById("annInput");
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

  document.getElementById("sessionName").textContent = " · " + CFG.name;
  document.getElementById("chromePath").textContent = CFG.name + " — live";

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function showErr(msg){ joinErr.textContent = msg; joinErr.style.display = "block"; }

  function ensureTerm(){
    if(termApi) return termApi;
    termApi = __vsCreateTerm(termBody);
    return termApi;
  }

  function exportBaseName(){
    var n = (CFG && CFG.name) ? String(CFG.name) : "session";
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

  function applyEntry(e){
    if(!e) return;
    if(typeof e.seq === "number"){
      if(e.seq <= lastSeq) return;
      lastSeq = e.seq;
      // termApi may not exist on the very first entry — noteSeqLine guards.
      noteSeqLine(e.seq);
    }
    __vsHandleEntry(ensureTerm(), e);
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

  var presenceExpanded = false;
  presenceLabel.addEventListener("click", function(){
    presenceExpanded = !presenceExpanded;
    if(presenceExpanded) presenceLabel.classList.add("expanded");
    else presenceLabel.classList.remove("expanded");
    presenceLabel.setAttribute("aria-expanded", presenceExpanded ? "true" : "false");
  });

  function renderPresence(viewers, watchingFallback){
    var names = [];
    var count = 0;
    if(Array.isArray(viewers)){
      for(var i = 0; i < viewers.length; i++){
        var v = viewers[i];
        if(!v || typeof v.name !== "string") continue;
        var n = sanitizePeerText(v.name, 32).trim() || "viewer";
        if(v.role === "viewer" || v.role === "spectator" || v.role === "collaborator") count++;
        names.push(escapeHtml(n));
      }
    } else if(typeof watchingFallback === "number"){
      count = watchingFallback;
    }
    var label = '👁 <b id="watching">' + count + "</b> watching";
    if(names.length > 0){
      label += ' <span class="names">· ' + names.map(function(n){ return "<em>" + n + "</em>"; }).join(", ") + "</span>";
    }
    presenceLabel.innerHTML = label;
    if(presenceExpanded) presenceLabel.classList.add("expanded");
    else presenceLabel.classList.remove("expanded");`;
