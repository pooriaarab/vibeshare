// Inlined browser JS for viewerPage, part 1 of 5.
// Split verbatim from the original template literal — the concatenation
// in page.ts reproduces it byte for byte.
export const VIEWER_JS_PART_1 = `(function(){
  "use strict";

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
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var badge = document.getElementById("badge");
  var termBody = document.getElementById("termBody");
  var cmdInput = document.getElementById("cmdInput");
  var sendBtn = document.getElementById("sendBtn");
  var namePanel = document.getElementById("namePanel");
  var nameInput = document.getElementById("nameInput");
  var joinBtn = document.getElementById("joinBtn");
  var watchingEl = document.getElementById("watching");
  var presenceLabel = document.getElementById("presenceLabel");
  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatSend = document.getElementById("chatSend");
  var chatForm = document.getElementById("chatForm");

  var reqBtn = document.getElementById("reqBtn");
  var canDrive = false;
  var dcOpen = false;  var termApi = null;
  var lastEntrySeq = 0;
  var myViewerId = null;
  var myName = "";
  var joined = false;
  var chatEmpty = true;
  var annLog = document.getElementById("annLog");
  var annInput = document.getElementById("annInput");
  var annSend = document.getElementById("annSend");
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

  function setBadge(cls, text){ badge.className = "badge" + (cls ? " " + cls : ""); badge.innerHTML = '<span class="d"></span> ' + text; }
  function fatal(msg){
    document.getElementById("errText").textContent = msg;
    document.getElementById("errPanel").classList.remove("hidden");
    namePanel.classList.add("hidden");
    setBadge("ended", "UNAVAILABLE");
  }
  function ensureTerm(){
    if(termApi) return termApi;
    termApi = __vsCreateTerm(termBody);
    return termApi;
  }
  function exportBaseName(){
    var n = shareId ? String(shareId) : "session";
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
  function applyEntry(entry){
    if(!entry) return;
    if(typeof entry.seq === "number"){
      if(entry.seq <= lastEntrySeq) return;
      lastEntrySeq = entry.seq;
      // termApi may not exist on the very first entry — noteSeqLine guards.
      noteSeqLine(entry.seq);
    }
    __vsHandleEntry(ensureTerm(), entry);
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

  // ---- share id from the path, key from the fragment (never sent anywhere)
  var idMatch = /\\/s\\/([A-Za-z0-9_-]+)/.exec(location.pathname);
  var shareId = idMatch ? idMatch[1] : null;
  if(!shareId){ fatal("This link has no share id."); return; }
  document.getElementById("shareLabel").textContent = " · " + shareId;
  document.getElementById("chromePath").textContent = shareId + " — live";

  var keyB64 = location.hash.slice(1);
  if(!keyB64){ fatal("This link is incomplete — the decryption key lives in the #fragment of the URL. Ask the host for the full link."); return; }

  // Build-a-grid entry: open the multi-view page with this share prefilled.
  // shareId + key are already URL-safe base64url — keep the fragment form raw.
  var gridLink = document.getElementById("gridLink");
  if(gridLink){
    gridLink.href = "/vibeshare/grid#" + shareId + "~" + keyB64;
    gridLink.classList.remove("hidden");
  }

  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";`;
