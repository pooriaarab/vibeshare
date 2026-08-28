export const GRID_JS_PART_1 = `(function(){
  "use strict";

  var SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

  var gridEl = document.getElementById("grid");
  var emptyEl = document.getElementById("emptyState");
  var addInput = document.getElementById("addInput");
  var addBtn = document.getElementById("addBtn");
  var addErr = document.getElementById("addErr");

  /** @type {Array<{id:string,key:string}>} */
  var shares = [];
  /** @type {Object.<string, any>} */
  var cells = {};
  var expandedId = null;
  var backdrop = null;

  function parseGridFragment(fragment){
    var raw = fragment.charAt(0) === "#" ? fragment.slice(1) : fragment;
    if(!raw) return [];
    var out = [];
    var seen = {};
    var parts = raw.split(",");
    for(var i = 0; i < parts.length; i++){
      var part = parts[i];
      var tilde = part.indexOf("~");
      if(tilde <= 0) continue;
      var id = part.slice(0, tilde).trim();
      var key = part.slice(tilde + 1).trim();
      if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
      if(seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, key: key });
    }
    return out;
  }

  function formatGridFragment(list){
    return list.map(function(s){ return s.id + "~" + s.key; }).join(",");
  }

  function parseSharePaste(input){
    var text = (input || "").trim();
    if(!text) return null;
    if(text.indexOf("/") === -1 && text.indexOf("#") === -1){
      var bare = parseGridFragment(text);
      return bare.length === 1 ? bare[0] : null;
    }
    var id = null;
    var key = "";
    try {
      var url = text.indexOf("://") !== -1 ? new URL(text) : new URL(text, location.origin);
      var m = /\\/(?:vibeshare\\/)?s\\/([A-Za-z0-9_-]+)/.exec(url.pathname);
      if(m) id = m[1];
      key = url.hash.charAt(0) === "#" ? url.hash.slice(1) : url.hash;
    } catch(e){
      var pair = parseGridFragment(text);
      return pair[0] || null;
    }
    if(!id || !key) return null;
    if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
    return { id: id, key: key };
  }

  function b64urlToBytes(s){
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setAddErr(msg){ addErr.textContent = msg || ""; }

  function writeHash(){
    var body = formatGridFragment(shares);
    var next = body ? "#" + body : "";
    if(location.hash !== next){
      // replaceState keeps back-stack clean while still updating the fragment.
      if(history.replaceState){
        history.replaceState(null, "", location.pathname + location.search + next);
      } else {
        location.hash = body;
      }
    }
  }

  function syncEmpty(){
    var n = shares.length;
    if(n === 0){
      emptyEl.hidden = false;
      gridEl.hidden = true;
    } else {
      emptyEl.hidden = true;
      gridEl.hidden = false;
    }
  }

  function setCellStatus(cell, state, label){
    cell.state = state;
    cell.dot.className = "cell-dot" + (state ? " " + state : "");
    cell.statusEl.textContent = label || state || "";
  }
`;
