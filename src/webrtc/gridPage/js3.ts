export const GRID_JS_PART_3 = `  function collapseExpanded(){
    if(!expandedId || !cells[expandedId]) {
      expandedId = null;
      if(backdrop){ try { backdrop.remove(); } catch(e){} backdrop = null; }
      document.body.classList.remove("grid-expanded");
      return;
    }
    var cell = cells[expandedId];
    cell.root.classList.remove("expanded");
    expandedId = null;
    if(backdrop){ try { backdrop.remove(); } catch(e){} backdrop = null; }
    document.body.classList.remove("grid-expanded");
    // Re-fit after layout settles.
    setTimeout(function(){ cell.conn.fit(); }, 50);
  }

  function expandCell(id){
    if(expandedId === id){ collapseExpanded(); return; }
    collapseExpanded();
    var cell = cells[id];
    if(!cell) return;
    expandedId = id;
    cell.root.classList.add("expanded");
    document.body.classList.add("grid-expanded");
    backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "expand-backdrop";
    backdrop.setAttribute("aria-label", "Close expanded session");
    backdrop.addEventListener("click", function(){ collapseExpanded(); });
    document.body.appendChild(backdrop);
    setTimeout(function(){ cell.conn.fit(); }, 50);
  }

  function removeShare(id, opts){
    opts = opts || {};
    if(expandedId === id) collapseExpanded();
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
      if(!opts.silent) setAddErr("Already in the grid: " + ref.id);
      return false;
    }
    shares.push({ id: ref.id, key: ref.key });
    if(!opts.skipHash) writeHash();
    syncEmpty();

    var root = document.createElement("div");
    root.className = "cell";
    root.dataset.shareId = ref.id;
    root.tabIndex = 0;
    root.setAttribute("role", "button");
    root.setAttribute("aria-label", "Session " + ref.id + " — click to expand");

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
    removeBtn.title = "Remove from grid";
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
    gridEl.appendChild(root);

    var cell = {
      root: root,
      body: body,
      dot: dot,
      statusEl: statusEl,
      state: "connecting",
      conn: null
    };

    function onStatus(state, label){ setCellStatus(cell, state, label); }

    cell.conn = connectShare(ref.id, ref.key, {
      getTermEl: function(){ return body; },
      onStatus: onStatus
    });
    cells[ref.id] = cell;

    root.addEventListener("click", function(ev){
      // Ignore clicks on the remove control (already stopPropagated).
      if(ev.target && ev.target.closest && ev.target.closest(".cell-remove")) return;
      expandCell(ref.id);
    });
    root.addEventListener("keydown", function(ev){
      if(ev.key === "Enter" || ev.key === " "){
        ev.preventDefault();
        expandCell(ref.id);
      } else if(ev.key === "Escape" && expandedId === ref.id){
        ev.preventDefault();
        collapseExpanded();
      }
    });

    return true;
  }

  function loadFromHash(){
    var next = parseGridFragment(location.hash || "");
    var nextIds = {};
    for(var i = 0; i < next.length; i++) nextIds[next[i].id] = true;
    Object.keys(cells).forEach(function(id){
      if(!nextIds[id]) removeShare(id, { skipHash: true });
    });
    shares = [];
    for(var j = 0; j < next.length; j++){
      var ref = next[j];
      if(cells[ref.id]){
        shares.push({ id: ref.id, key: ref.key });
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
    if(addShare(ref)){
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

  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape" && expandedId){
      ev.preventDefault();
      collapseExpanded();
    }
  });

  window.addEventListener("hashchange", function(){ loadFromHash(); });

  // Initial paint from fragment.
  loadFromHash();
})();
`;
