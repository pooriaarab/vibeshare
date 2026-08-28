export const CANVAS_JS_PART_3 = `  function setCellStatus(cell, state, label){
    cell.state = state;
    cell.dot.className = "cell-dot" + (state ? " " + state : "");
    cell.statusEl.textContent = label || state || "";
  }

  function placeCell(cell){
    cell.root.style.left = cell.x + "px";
    cell.root.style.top = cell.y + "px";
  }

  // Cascade new shares so they don't all stack at (0,0).
  function autoPosition(){
    var n = Object.keys(cells).length;
    return { x: 40 + (n % 3) * 60, y: 40 + Math.floor(n / 3) * 60 };
  }

  function removeShare(id, opts){
    opts = opts || {};
    var cell = cells[id];
    if(cell){
      try { cell.conn.close(); } catch(e){}
      try { cell.root.remove(); } catch(e){}
      delete cells[id];
    }
    shares = shares.filter(function(s){ return s.id !== id; });
    if(!opts.skipHash) writeHash();
    syncEmpty();
  }

  function addShare(ref, opts){
    opts = opts || {};
    if(!ref || !ref.id || !ref.key) return false;
    if(cells[ref.id]){
      if(!opts.silent) setAddErr("Already on the board: " + ref.id);
      return false;
    }
    var pos = (typeof ref.x === "number" && typeof ref.y === "number" && !opts.autoPlace)
      ? { x: ref.x, y: ref.y } : autoPosition();
    shares.push({ id: ref.id, key: ref.key, x: pos.x, y: pos.y });
    if(!opts.skipHash) writeHash();
    syncEmpty();

    var root = document.createElement("div");
    root.className = "cell";
    root.dataset.shareId = ref.id;

    var head = document.createElement("div");
    head.className = "cell-head";

    var dot = document.createElement("span");
    dot.className = "cell-dot connecting";
    dot.setAttribute("aria-hidden", "true");

    var idEl = document.createElement("span");
    idEl.className = "cell-id";
    idEl.textContent = ref.id;
    idEl.title = ref.id;

    var statusEl = document.createElement("span");
    statusEl.className = "cell-status";
    statusEl.textContent = "CONNECTING";

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cell-remove";
    removeBtn.title = "Remove from board";
    removeBtn.setAttribute("aria-label", "Remove " + ref.id);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      removeShare(ref.id);
    });

    head.appendChild(dot);
    head.appendChild(idEl);
    head.appendChild(statusEl);
    head.appendChild(removeBtn);

    var body = document.createElement("div");
    body.className = "cell-body";

    root.appendChild(head);
    root.appendChild(body);
    boardEl.appendChild(root);

    var cell = {
      root: root,
      body: body,
      dot: dot,
      statusEl: statusEl,
      state: "connecting",
      x: pos.x,
      y: pos.y,
      conn: null
    };
    placeCell(cell);

    // Drag the HEADER to reposition the cell in board space; persist on drop.
    startCellDrag(cell, head);

    function onStatus(state, label){ setCellStatus(cell, state, label); }
    cell.conn = connectShare(ref.id, ref.key, {
      getTermEl: function(){ return body; },
      onStatus: onStatus
    });
    cells[ref.id] = cell;

    return true;
  }

  function startCellDrag(cell, handle){
    handle.addEventListener("mousedown", function(ev){
      if(ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      var startMX = ev.clientX, startMY = ev.clientY;
      var startX = cell.x, startY = cell.y;
      cell.root.style.zIndex = 20;
      function move(e){
        // Convert screen-space delta to board space via the current zoom.
        cell.x = startX + (e.clientX - startMX) / zoom;
        cell.y = startY + (e.clientY - startMY) / zoom;
        placeCell(cell);
      }
      function up(){
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        cell.root.style.zIndex = "";
        cell.x = Math.round(cell.x);
        cell.y = Math.round(cell.y);
        placeCell(cell);
        for(var i = 0; i < shares.length; i++){
          if(shares[i].id === cell.root.dataset.shareId){
            shares[i].x = cell.x;
            shares[i].y = cell.y;
          }
        }
        writeHash();
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // Pan: drag the empty board background.
  viewportEl.addEventListener("mousedown", function(ev){
    if(ev.button !== 0) return;
    // Only pan when the press lands on the empty board/viewport (not a cell).
    if(ev.target && ev.target.closest && ev.target.closest(".cell")) return;
    ev.preventDefault();
    viewportEl.classList.add("panning");
    var startMX = ev.clientX, startMY = ev.clientY;
    var startPX = panX, startPY = panY;
    function move(e){
      panX = startPX + (e.clientX - startMX);
      panY = startPY + (e.clientY - startMY);
      applyTransform();
    }
    function up(){
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      viewportEl.classList.remove("panning");
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // Zoom: wheel over the viewport, anchored to the cursor.
  viewportEl.addEventListener("wheel", function(ev){
    ev.preventDefault();
    var delta = -ev.deltaY;
    if(ev.deltaMode === 1) delta *= 16; // DOM_DELTA_LINE → px-ish
    else if(ev.deltaMode === 2) delta *= 100; // DOM_DELTA_PAGE
    var factor = Math.exp(delta * 0.0015);
    setZoom(zoom * factor, ev.clientX, ev.clientY);
  }, { passive: false });

  if(zoomInBtn) zoomInBtn.addEventListener("click", function(){
    var rect = viewportEl.getBoundingClientRect();
    setZoom(zoom * 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  if(zoomOutBtn) zoomOutBtn.addEventListener("click", function(){
    var rect = viewportEl.getBoundingClientRect();
    setZoom(zoom / 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });

  function loadFromHash(){
    var next = parseCanvasFragment(location.hash || "");
    var nextIds = {};
    for(var i = 0; i < next.length; i++) nextIds[next[i].id] = true;
    Object.keys(cells).forEach(function(id){
      if(!nextIds[id]) removeShare(id, { skipHash: true });
    });
    shares = [];
    for(var j = 0; j < next.length; j++){
      var ref = next[j];
      if(cells[ref.id]){
        // Already on the board — just sync its position.
        var c = cells[ref.id];
        c.x = ref.x; c.y = ref.y;
        placeCell(c);
        shares.push({ id: ref.id, key: ref.key, x: ref.x, y: ref.y });
      } else {
        addShare(ref, { skipHash: true, silent: true });
      }
    }
    syncEmpty();
  }

  addBtn.addEventListener("click", function(){
    setAddErr("");
    var ref = parseSharePaste(addInput.value || "");
    if(!ref){
      setAddErr("Paste a full share link (…/s/<id>#<key>) or id~key.");
      return;
    }
    if(addShare(ref, { autoPlace: true })){
      addInput.value = "";
      setAddErr("");
    }
  });
  addInput.addEventListener("keydown", function(ev){
    if(ev.key === "Enter"){
      ev.preventDefault();
      addBtn.click();
    }
  });

  window.addEventListener("hashchange", function(){ loadFromHash(); });

  // Initial paint from fragment.
  applyTransform();
  loadFromHash();
})();
`;
