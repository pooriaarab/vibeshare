export const CANVAS_JS_PART_1 = `(function(){
  "use strict";

  var SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
  var MIN_ZOOM = 0.3, MAX_ZOOM = 2;

  var viewportEl = document.getElementById("viewport");
  var boardEl = document.getElementById("board");
  var emptyEl = document.getElementById("emptyState");
  var addInput = document.getElementById("addInput");
  var addBtn = document.getElementById("addBtn");
  var addErr = document.getElementById("addErr");
  var zoomInBtn = document.getElementById("zoomIn");
  var zoomOutBtn = document.getElementById("zoomOut");
  var zoomLabel = document.getElementById("zoomLabel");

  /** @type {Array<{id:string,key:string,x:number,y:number}>} */
  var shares = [];
  /** @type {Object.<string, any>} */
  var cells = {};

  // Board view state (pan in viewport px, zoom is unitless scale).
  var panX = 48, panY = 48, zoom = 1;

  function parseCanvasFragment(fragment){
    var raw = fragment.charAt(0) === "#" ? fragment.slice(1) : fragment;
    if(!raw) return [];
    var out = [];
    var seen = {};
    var parts = raw.split(",");
    for(var i = 0; i < parts.length; i++){
      var part = parts[i];
      var segs = part.split("~");
      var id = (segs[0] || "").trim();
      var key = (segs[1] || "").trim();
      if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) continue;
      if(seen[id]) continue;
      var x = 0, y = 0;
      if(segs.length >= 4){
        var px = parseInt((segs[2] || "").trim(), 10);
        var py = parseInt((segs[3] || "").trim(), 10);
        if(isNaN(px) || isNaN(py)) continue;
        x = px; y = py;
      }
      seen[id] = true;
      out.push({ id: id, key: key, x: x, y: y });
    }
    return out;
  }

  function formatCanvasFragment(list){
    return list.map(function(s){ return s.id + "~" + s.key + "~" + s.x + "~" + s.y; }).join(",");
  }

  function parseSharePaste(input){
    var text = (input || "").trim();
    if(!text) return null;
    if(text.indexOf("/") === -1 && text.indexOf("#") === -1){
      // Bare id~key (or id~key~x~y) — take the first canvas pair.
      var bare = parseCanvasFragment(text);
      return bare.length === 1 ? bare[0] : null;
    }
    var id = null, key = "";
    try {
      var url = text.indexOf("://") !== -1 ? new URL(text) : new URL(text, location.origin);
      var m = /\\/(?:vibeshare\\/)?s\\/([A-Za-z0-9_-]+)/.exec(url.pathname);
      if(m) id = m[1];
      key = url.hash.charAt(0) === "#" ? url.hash.slice(1) : url.hash;
    } catch(e){
      var pair = parseCanvasFragment(text);
      return pair[0] || null;
    }
    if(!id || !key) return null;
    if(!SHARE_ID_RE.test(id) || !KEY_RE.test(key)) return null;
    return { id: id, key: key, x: 0, y: 0 };
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
    var body = formatCanvasFragment(shares);
    var next = body ? "#" + body : "";
    if(location.hash !== next){
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
      viewportEl.hidden = true;
    } else {
      emptyEl.hidden = true;
      viewportEl.hidden = false;
    }
  }

  function applyTransform(){
    boardEl.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
    if(zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + "%";
  }

  // Zoom around a viewport-space point (cursor / control center) so the board
  // point under it stays fixed on screen.
  function setZoom(newZoom, originClientX, originClientY){
    var z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if(typeof originClientX === "number" && typeof originClientY === "number"){
      var rect = viewportEl.getBoundingClientRect();
      var cx = originClientX - rect.left;
      var cy = originClientY - rect.top;
      var bx = (cx - panX) / zoom;
      var by = (cy - panY) / zoom;
      panX = cx - bx * z;
      panY = cy - by * z;
    }
    zoom = z;
    applyTransform();
  }
`;
