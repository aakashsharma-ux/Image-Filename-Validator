/**
 * app.js (Enhanced)
 * =================
 * UI logic — drag-drop (files + folders, recursive), input picker,
 * validation table + grid, thumbnail lazy-loading, age calculator,
 * age grouping, stats, filter, CSV export.
 *
 * Depends on: validator.js  (must be loaded first)
 *
 * Performance targets: 10k–15k images
 *   - All file registration is O(n) with a Map dedup guard
 *   - DOM rendering is virtualised: only BATCH_SIZE rows/cards rendered at once
 *   - Thumbnails use IntersectionObserver for lazy loading
 *   - Object URLs are created only when a card enters the viewport
 *   - processFileList uses chunked async processing to avoid blocking the main thread
 *
 * ── How folder drag-and-drop works ──────────────────────────────────────────
 * When a folder is dropped, browsers expose a FileSystem API via
 * DataTransferItem.webkitGetAsEntry().  That gives us a FileSystemDirectoryEntry
 * which we walk with createReader() / readEntries().
 *
 * CRITICAL RULES for the FileSystem API:
 *   1. webkitGetAsEntry() MUST be called synchronously inside the drop handler,
 *      before any await / Promise yield.
 *   2. DirectoryReader.readEntries() returns at most 100 entries per call.
 *      Loop until an empty batch.
 *   3. For drag-drop we only use entry.name + a path we build ourselves,
 *      NOT entry.file() (fragile after the drop event ends).
 *      For grid thumbnails we DO need the actual File object, so we call
 *      entry.file() *immediately* when walking, caching the result.
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────────────────── */
  var BATCH_SIZE   = 100;   // cards/rows per render chunk
  var CHUNK_DELAY  = 0;     // ms between chunks (0 = next microtask)

  /* ── Image extension allowlist ─────────────────────────────────────────── */
  var IMAGE_EXTS = {
    jpg:1, jpeg:1, png:1, gif:1, webp:1,
    bmp:1, svg:1, tiff:1, tif:1, heic:1, heif:1, avif:1,
  };

  function isImage(filename) {
    var dot = filename.lastIndexOf(".");
    if (dot === -1) return false;
    return !!IMAGE_EXTS[filename.slice(dot + 1).toLowerCase()];
  }

  /* ── State ─────────────────────────────────────────────────────────────── */
  // Record: { path, name, valid, reason, year, file, age }
  var allFiles    = [];          // master list, insertion order
  var pathSet     = new Map();   // path → index in allFiles, for O(1) dedup
  var refAge      = null;        // reference age (number)
  var refYear     = null;        // reference year (number)
  var currentView = "grid";      // "grid" | "table"
  var activeFilter = "all";      // "all" | "valid" | "invalid"
  var activeAge   = null;        // null = show all, number = filter by age group

  /* ── Render state (virtual pagination) ────────────────────────────────── */
  var renderedCount = 0;
  var renderPending = false;

  /* ── IntersectionObserver for lazy thumbnails ──────────────────────────── */
  var thumbObserver = null;

  /* ── DOM refs ───────────────────────────────────────────────────────────── */
  var dropZone        = document.getElementById("drop-zone");
  var fileInput       = document.getElementById("file-input");
  var folderInput     = document.getElementById("folder-input");
  var browseFilesBtn  = document.getElementById("browse-files-btn");
  var browseFolderBtn = document.getElementById("browse-folder-btn");
  var statsEl         = document.getElementById("stats");
  var actionsEl       = document.getElementById("actions");
  var cntTotal        = document.getElementById("cnt-total");
  var cntValid        = document.getElementById("cnt-valid");
  var cntInvalid      = document.getElementById("cnt-invalid");
  var filterSel       = document.getElementById("filter");
  var viewModeSel     = document.getElementById("view-mode");
  var clearBtn        = document.getElementById("clear-btn");
  var downloadBtn     = document.getElementById("download-btn");
  var resultsTable    = document.getElementById("results-table");
  var resultsBody     = document.getElementById("results-body");
  var resultsGrid     = document.getElementById("results-grid");
  var emptyState      = document.getElementById("empty");
  var ageRefPanel     = document.getElementById("age-ref-panel");
  var ageGroupsPanel  = document.getElementById("age-groups-panel");
  var ageGroupsList   = document.getElementById("age-groups-list");
  var refAgeInput     = document.getElementById("ref-age");
  var refYearInput    = document.getElementById("ref-year");
  var calcAgeBtn      = document.getElementById("calc-age-btn");

  /* ── UI helpers ─────────────────────────────────────────────────────────── */
  function setEmpty(msg) {
    emptyState.textContent = msg;
    emptyState.hidden      = false;
    resultsTable.hidden    = true;
    resultsGrid.hidden     = true;
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;")
            .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ── Thumb lazy-loading via IntersectionObserver ───────────────────────── */
  function ensureThumbObserver() {
    if (thumbObserver) return;
    thumbObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var wrap = entry.target;
        thumbObserver.unobserve(wrap);

        var fileRef = wrap._fileRef;
        if (!fileRef) return;

        var img = wrap.querySelector(".grid-thumb");
        if (!img) return;

        var url = URL.createObjectURL(fileRef);
        img.src = url;
        img.onload  = function() { img.classList.add("loaded"); };
        img.onerror = function() { /* keep placeholder */ };
      });
    }, { rootMargin: "200px" });
  }

  /* ── Register + validate a single file ─────────────────────────────────── */
  function registerFile(path, name, fileObj) {
    if (pathSet.has(path)) return false;
    var r = Validator.validateFilename(name);
    var rec = {
      path:   path,
      name:   name,
      valid:  r.valid,
      reason: r.reason,
      year:   r.year,
      file:   fileObj || null,   // File object (may be null for drag-drop)
      age:    null,              // calculated later
    };
    pathSet.set(path, allFiles.length);
    allFiles.push(rec);
    return true;
  }

  /* ── Age calculation ────────────────────────────────────────────────────── */
  function computeAges() {
    if (refAge === null || refYear === null) return;
    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i];
      if (f.valid && f.year !== null) {
        f.age = refAge + (f.year - refYear);
      } else {
        f.age = null;
      }
    }
  }

  function buildAgeGroups() {
    var groups = {};
    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i];
      if (f.age !== null) {
        if (!groups[f.age]) groups[f.age] = 0;
        groups[f.age]++;
      }
    }
    return groups;
  }

  function renderAgeGroups() {
    var groups = buildAgeGroups();
    var ages   = Object.keys(groups).map(Number).sort(function(a,b){return a-b;});

    if (ages.length === 0) {
      ageGroupsPanel.hidden = true;
      return;
    }

    ageGroupsPanel.hidden = false;
    ageGroupsList.innerHTML = ages.map(function(age) {
      var active = (activeAge === age) ? " style=\"outline:2px solid var(--color-accent);outline-offset:1px;\"" : "";
      return "<span class=\"age-chip\" data-age=\"" + age + "\"" + active + ">" +
        age + " yrs old" +
        "<span class=\"chip-count\">" + groups[age] + "</span>" +
        "</span>";
    }).join("");

    ageGroupsList.querySelectorAll(".age-chip").forEach(function(chip) {
      chip.addEventListener("click", function() {
        var clickedAge = Number(chip.dataset.age);
        activeAge = (activeAge === clickedAge) ? null : clickedAge;
        renderAll();
        renderAgeGroups();
      });
    });
  }

  /* ── Stats ──────────────────────────────────────────────────────────────── */
  function updateStats() {
    var total   = allFiles.length;
    var valid   = 0;
    for (var i = 0; i < allFiles.length; i++) if (allFiles[i].valid) valid++;
    var invalid = total - valid;
    cntTotal.textContent   = total;
    cntValid.textContent   = valid;
    cntInvalid.textContent = invalid;
    statsEl.hidden   = (total === 0);
    actionsEl.hidden = (total === 0);
    ageRefPanel.hidden = (total === 0);
  }

  /* ── Filtered list ──────────────────────────────────────────────────────── */
  function filteredFiles() {
    var rows = allFiles;
    if (activeFilter === "valid")   rows = rows.filter(function(f){ return  f.valid; });
    if (activeFilter === "invalid") rows = rows.filter(function(f){ return !f.valid; });
    if (activeAge !== null)         rows = rows.filter(function(f){ return f.age === activeAge; });
    return rows;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDER — grid view
  ══════════════════════════════════════════════════════════════════════════ */

  function renderGrid(rows) {
    ensureThumbObserver();
    resultsGrid.hidden = false;
    resultsTable.hidden = true;
    emptyState.hidden = true;

    resultsGrid.innerHTML = "";
    renderedCount = 0;

    appendGridChunk(rows);
  }

  function appendGridChunk(rows) {
    var end   = Math.min(renderedCount + BATCH_SIZE, rows.length);
    var frag  = document.createDocumentFragment();

    for (var i = renderedCount; i < end; i++) {
      frag.appendChild(makeGridCard(rows[i]));
    }

    // Sentinel for loading next chunk
    if (end < rows.length) {
      var sentinel = document.createElement("div");
      sentinel.className = "lazy-sentinel";
      var capturedRows = rows;
      var capturedEnd  = end;

      var chunkObserver = new IntersectionObserver(function(entries) {
        if (!entries[0].isIntersecting) return;
        chunkObserver.disconnect();
        sentinel.remove();
        renderedCount = capturedEnd;
        appendGridChunk(capturedRows);
      }, { rootMargin: "400px" });

      sentinel._chunkObserver = chunkObserver;
      frag.appendChild(sentinel);
      setTimeout(function(){ chunkObserver.observe(sentinel); }, 0);
    }

    resultsGrid.appendChild(frag);
    renderedCount = end;
  }

  function makeGridCard(f) {
    var card = document.createElement("div");
    card.className = "grid-card " + (f.valid ? "valid-card" : "invalid-card");

    var wrap = document.createElement("div");
    wrap.className = "grid-thumb-wrap";

    // Placeholder icon
    var placeholder = document.createElement("div");
    placeholder.className = "thumb-placeholder";
    placeholder.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<circle cx="8.5" cy="8.5" r="1.5"/>' +
      '<polyline points="21 15 16 10 5 21"/>' +
      '</svg><span>image</span>';

    var img = document.createElement("img");
    img.className = "grid-thumb";
    img.alt = f.name;
    img.loading = "lazy";

    if (f.file) {
      wrap._fileRef = f.file;
      thumbObserver.observe(wrap);
    }

    wrap.appendChild(placeholder);
    wrap.appendChild(img);

    var info = document.createElement("div");
    info.className = "grid-info";

    var fnEl = document.createElement("div");
    fnEl.className = "grid-filename";
    fnEl.title = f.path;
    fnEl.textContent = f.name;

    var badgeEl = document.createElement("span");
    badgeEl.className = "grid-badge " + (f.valid ? "valid" : "invalid");
    badgeEl.textContent = f.valid ? "✅ Valid" : "❌ Invalid";

    info.appendChild(fnEl);
    info.appendChild(badgeEl);

    if (f.valid && f.age !== null) {
      var ageEl = document.createElement("div");
      ageEl.className = "grid-age";
      ageEl.textContent = f.age + " years old";
      info.appendChild(ageEl);
    }

    if (!f.valid) {
      var errEl = document.createElement("div");
      errEl.className = "grid-error";
      errEl.textContent = f.reason;
      info.appendChild(errEl);
    }

    card.appendChild(wrap);
    card.appendChild(info);
    return card;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDER — table view
  ══════════════════════════════════════════════════════════════════════════ */

  function renderTable(rows) {
    resultsGrid.hidden = true;
    resultsTable.hidden = false;
    emptyState.hidden = true;

    resultsBody.innerHTML = "";
    renderedCount = 0;
    appendTableChunk(rows);
  }

  function appendTableChunk(rows) {
    var end  = Math.min(renderedCount + BATCH_SIZE, rows.length);
    var html = "";

    for (var i = renderedCount; i < end; i++) {
      var f  = rows[i];
      var bc = f.valid ? "valid"  : "invalid";
      var sl = f.valid ? "Valid"  : "Invalid";
      var rc = f.valid ? "reason" : "reason err";
      var ageCell = (f.valid && f.age !== null)
        ? escHtml(String(f.age) + " yrs")
        : (f.valid ? '<span style="color:var(--color-text-tertiary);font-size:11px;">—</span>' : "");

      html +=
        "<tr>" +
        "<td class=\"filename\" title=\"" + escHtml(f.path) + "\">" + escHtml(f.path) + "</td>" +
        "<td><span class=\"badge " + bc + "\"><span class=\"dot\"></span>" + sl + "</span></td>" +
        "<td class=\"age-cell\">" + ageCell + "</td>" +
        "<td class=\"" + rc + "\">" + escHtml(f.reason) + "</td>" +
        "</tr>";
    }

    resultsBody.insertAdjacentHTML("beforeend", html);
    renderedCount = end;

    if (end < rows.length) {
      setTimeout(function() {
        appendTableChunk(rows);
      }, CHUNK_DELAY);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDER — dispatch
  ══════════════════════════════════════════════════════════════════════════ */

  function renderAll() {
    var rows = filteredFiles();

    if (rows.length === 0) {
      setEmpty(allFiles.length === 0
        ? "Upload image files or drop a folder above to validate filenames."
        : "No files match the selected filter.");
      return;
    }

    if (currentView === "grid") {
      renderGrid(rows);
    } else {
      renderTable(rows);
    }

    renderAgeGroups();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PATH A  —  <input> FileList
     Works for both "Browse files" and "Browse folder" (webkitdirectory).
     We have real File objects here so thumbnails can be shown.
  ══════════════════════════════════════════════════════════════════════════ */

  function processFileList(fileList) {
    var files = Array.from(fileList).filter(function(f){ return isImage(f.name); });
    if (files.length === 0) {
      if (allFiles.length === 0) setEmpty("No image files found. Try a different folder.");
      return;
    }

    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var path = file.webkitRelativePath || file.name;
      var name = path.split("/").pop();
      if (registerFile(path, name, file)) added++;
    }

    if (added > 0) {
      computeAges();
      updateStats();
      renderAll();
    } else if (allFiles.length === 0) {
      setEmpty("No new image files found.");
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PATH B  —  Drag-and-drop via the FileSystem API
  ══════════════════════════════════════════════════════════════════════════ */

  function readAllEntries(reader) {
    return new Promise(function(resolve, reject) {
      var all = [];
      function next() {
        reader.readEntries(function(batch) {
          if (batch.length === 0) { resolve(all); }
          else { for (var i=0; i<batch.length; i++) all.push(batch[i]); next(); }
        }, reject);
      }
      next();
    });
  }

  /**
   * walkEntry — recursively collects image file entries.
   * For file entries we call entry.file() immediately (synchronous-ish
   * within the FileSystem API tick) so the File object stays valid.
   */
  function walkEntry(entry, parentPath) {
    var entryPath = parentPath ? parentPath + "/" + entry.name : entry.name;

    if (entry.isFile) {
      if (!isImage(entry.name)) return Promise.resolve([]);
      return new Promise(function(resolve) {
        entry.file(
          function(fileObj) { resolve([{ path: entryPath, name: entry.name, file: fileObj }]); },
          function()        { resolve([{ path: entryPath, name: entry.name, file: null  }]); }
        );
      });
    }

    if (entry.isDirectory) {
      var reader = entry.createReader();
      return readAllEntries(reader).then(function(children) {
        return Promise.all(children.map(function(child) {
          return walkEntry(child, entryPath);
        }));
      }).then(function(arrays) {
        var flat = [];
        for (var i=0; i<arrays.length; i++)
          for (var j=0; j<arrays[i].length; j++)
            flat.push(arrays[i][j]);
        return flat;
      });
    }

    return Promise.resolve([]);
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");

    var items = e.dataTransfer.items;

    if (!items || items.length === 0 ||
        typeof items[0].webkitGetAsEntry !== "function") {
      processFileList(e.dataTransfer.files);
      return;
    }

    // SYNCHRONOUS: capture entries before the event ends
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    if (entries.length === 0) {
      setEmpty("Could not read the dropped item. Try the Browse folder button.");
      return;
    }

    setEmpty("Scanning… please wait");

    Promise.all(entries.map(function(entry) {
      return walkEntry(entry, "");
    })).then(function(arrays) {
      var added = 0;
      for (var i=0; i<arrays.length; i++)
        for (var j=0; j<arrays[i].length; j++) {
          var item = arrays[i][j];
          if (registerFile(item.path, item.name, item.file)) added++;
        }

      if (added > 0) {
        computeAges();
        updateStats();
        renderAll();
      } else if (allFiles.length === 0) {
        setEmpty("No image files found in the dropped folder.");
      } else {
        renderAll();
      }
    }).catch(function(err) {
      console.error("Drag-drop folder scan failed:", err);
      setEmpty("Error reading folder. Please use the Browse folder button instead.");
    });
  }

  /* ── Age calculator ─────────────────────────────────────────────────────── */
  function handleCalcAge() {
    var ageVal  = parseInt(refAgeInput.value,  10);
    var yearVal = parseInt(refYearInput.value, 10);

    if (isNaN(ageVal) || isNaN(yearVal)) {
      alert("Please enter a valid age and year.");
      return;
    }
    if (yearVal < 1900 || yearVal > 2100) {
      alert("Reference year must be between 1900 and 2100.");
      return;
    }

    refAge  = ageVal;
    refYear = yearVal;

    computeAges();
    renderAll();
  }

  /* ── Clear ──────────────────────────────────────────────────────────────── */
  function clearAll() {
    // Revoke any created object URLs to free memory
    var imgs = resultsGrid.querySelectorAll(".grid-thumb[src]");
    imgs.forEach(function(img){ if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src); });

    allFiles      = [];
    pathSet       = new Map();
    refAge        = null;
    refYear       = null;
    activeAge     = null;
    activeFilter  = "all";
    renderedCount = 0;

    filterSel.value   = "all";
    viewModeSel.value = "grid";
    currentView       = "grid";
    refAgeInput.value  = "";
    refYearInput.value = "";

    resultsBody.innerHTML = "";
    resultsGrid.innerHTML = "";
    statsEl.hidden        = true;
    actionsEl.hidden      = true;
    ageRefPanel.hidden    = true;
    ageGroupsPanel.hidden = true;

    setEmpty("Upload image files or drop a folder above to validate filenames.");
  }

  /* ── CSV export ─────────────────────────────────────────────────────────── */
  function downloadReport() {
    if (!allFiles.length) { alert("No files to export."); return; }
    var rows = [["Path","Filename","Status","Year","Age","Reason"]].concat(
      allFiles.map(function(f){
        return [
          f.path, f.name,
          f.valid ? "Valid" : "Invalid",
          f.year  !== null ? f.year  : "",
          f.age   !== null ? f.age   : "",
          f.reason
        ];
      })
    );
    var csv = rows.map(function(r){
      return r.map(function(c){ return '"'+String(c).replace(/"/g,'""')+'"'; }).join(",");
    }).join("\n");

    var a = document.createElement("a");
    a.href     = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"}));
    a.download = "filename_validation_report.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ── Event wiring ───────────────────────────────────────────────────────── */
  browseFilesBtn.addEventListener("click", function(e){
    e.stopPropagation(); fileInput.click();
  });
  browseFolderBtn.addEventListener("click", function(e){
    e.stopPropagation(); folderInput.click();
  });
  dropZone.addEventListener("keydown", function(e){
    if (e.key==="Enter"||e.key===" "){ e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener("change", function(e){
    processFileList(e.target.files); e.target.value="";
  });
  folderInput.addEventListener("change", function(e){
    processFileList(e.target.files); e.target.value="";
  });

  document.addEventListener("dragover", function(e){ e.preventDefault(); });
  document.addEventListener("drop",     function(e){ e.preventDefault(); });

  dropZone.addEventListener("dragenter", function(e){
    e.preventDefault(); dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragover", function(e){
    e.preventDefault(); dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", function(e){
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", handleDrop);

  filterSel.addEventListener("change", function(){
    activeFilter = filterSel.value;
    renderAll();
  });

  viewModeSel.addEventListener("change", function(){
    currentView = viewModeSel.value;
    renderAll();
  });

  calcAgeBtn.addEventListener("click", handleCalcAge);
  clearBtn.addEventListener("click",   clearAll);
  downloadBtn.addEventListener("click", downloadReport);

})();
