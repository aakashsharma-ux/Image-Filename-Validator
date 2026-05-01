/**
 * app.js  (v2)
 * ============
 * Enhanced UI logic — all original features preserved, plus:
 *   • Folder upload with recursive subfolder scanning
 *   • Image preview grid with lazy-loading (IntersectionObserver)
 *   • Year extraction + reference-age/year input → age calculation
 *   • Age-based grouping & summary
 *   • Pagination for the validation table (100 rows / page)
 *   • Chunked async processing for large datasets (10k–15k images)
 *   • Progress bar during large uploads
 *   • CSV export now includes Year and Age columns
 *
 * Depends on: validator.js  (must be loaded first)
 *
 * ── FileSystem API notes (same caveats as v1) ────────────────────────────
 *   1. webkitGetAsEntry() MUST be called synchronously inside the drop handler.
 *   2. DirectoryReader.readEntries() yields ≤ 100 entries per call — loop until empty.
 *   3. entry.file() IS called here (unlike v1) so we can generate thumbnails.
 *      It is wrapped in a Promise with an error fallback (null file object).
 * ─────────────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════════════════════ */

  var IMAGE_EXTS = {
    jpg:1, jpeg:1, png:1, gif:1, webp:1,
    bmp:1, svg:1, tiff:1, tif:1, heic:1, heif:1, avif:1,
  };

  var TABLE_PAGE_SIZE   = 100;   // rows per table page
  var PREVIEW_CHUNK     = 60;    // preview cards added per IntersectionObserver trigger
  var PROCESS_CHUNK     = 500;   // files registered per async batch

  /* ═══════════════════════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Central data store.
   * Each entry: { path, name, valid, reason, year, file }
   *   path   — full relative path (for display & de-duplication)
   *   name   — bare filename
   *   valid  — boolean
   *   reason — human-readable validation result / error
   *   year   — Number|null  (extracted from valid filenames only)
   *   file   — File|null    (browser File object for thumbnail generation)
   */
  var allFiles = [];

  // Cached filtered views (rebuilt on filter change)
  var filteredTable   = [];
  var filteredPreview = [];

  // Pagination
  var currentTablePage    = 1;
  var currentTableFilter  = "all";
  var currentPreviewFilter = "all";

  // Preview infinite-scroll cursor
  var previewRenderedCount = 0;

  // IntersectionObserver handles
  var thumbObserver    = null;
  var sentinelObserver = null;

  /* ═══════════════════════════════════════════════════════════════════════════
     DOM REFS
  ═══════════════════════════════════════════════════════════════════════════ */

  var dropZone          = document.getElementById("drop-zone");
  var fileInput         = document.getElementById("file-input");
  var folderInput       = document.getElementById("folder-input");
  var browseFilesBtn    = document.getElementById("browse-files-btn");
  var browseFolderBtn   = document.getElementById("browse-folder-btn");
  // Progress
  var progressWrap      = document.getElementById("progress-wrap");
  var progressBar       = document.getElementById("progress-bar");
  var progressText      = document.getElementById("progress-text");
  // Stats
  var statsEl           = document.getElementById("stats");
  var actionsEl         = document.getElementById("actions");
  var cntTotal          = document.getElementById("cnt-total");
  var cntValid          = document.getElementById("cnt-valid");
  var cntInvalid        = document.getElementById("cnt-invalid");
  // Table controls
  var filterSel         = document.getElementById("filter");
  var clearBtn          = document.getElementById("clear-btn");
  var downloadBtn       = document.getElementById("download-btn");
  var resultsTable      = document.getElementById("results-table");
  var resultsBody       = document.getElementById("results-body");
  var emptyState        = document.getElementById("empty");
  var tableHeaderBar    = document.getElementById("table-header-bar");
  var tablePageLabel    = document.getElementById("table-page-label");
  var pageNumEl         = document.getElementById("page-num");
  var pagePrevBtn       = document.getElementById("page-prev-btn");
  var pageNextBtn       = document.getElementById("page-next-btn");
  // Age section
  var ageSectionEl      = document.getElementById("age-section");
  var refAgeInput       = document.getElementById("ref-age");
  var refYearInput      = document.getElementById("ref-year");
  var ageGroupsWrap     = document.getElementById("age-groups-wrap");
  var ageGroupsEl       = document.getElementById("age-groups");
  var cntGroupsEl       = document.getElementById("cnt-groups");
  var ageRangeEl        = document.getElementById("age-range");
  var cntDatedEl        = document.getElementById("cnt-dated");
  var ageHintEl         = document.getElementById("age-hint");
  // Preview section
  var previewSection    = document.getElementById("preview-section");
  var previewGrid       = document.getElementById("preview-grid");
  var previewSentinel   = document.getElementById("preview-sentinel");
  var previewCountLabel = document.getElementById("preview-count-label");
  var previewFilterSel  = document.getElementById("preview-filter");

  /* ═══════════════════════════════════════════════════════════════════════════
     UTILITIES
  ═══════════════════════════════════════════════════════════════════════════ */

  function isImage(filename) {
    var dot = filename.lastIndexOf(".");
    return dot !== -1 && !!IMAGE_EXTS[filename.slice(dot + 1).toLowerCase()];
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Extract the 4-digit year from a validated filename stem (mmm_dd_yyyy). */
  function extractYear(name) {
    var stem = Validator.stripExtension(name);
    var m = stem.match(/^[a-z]{3}_\d{2}_(\d{4})$/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Get reference age/year inputs; returns null if either is missing. */
  function getRef() {
    var a = parseInt(refAgeInput.value, 10);
    var y = parseInt(refYearInput.value, 10);
    return (!isNaN(a) && !isNaN(y)) ? { age: a, year: y } : null;
  }

  /** Age formula: ref.age + (imageYear - ref.year). */
  function calcAge(imageYear, ref) {
    return ref.age + (imageYear - ref.year);
  }

  /** Show / update empty state in the table area. */
  function setEmpty(msg) {
    emptyState.textContent = msg;
    emptyState.hidden      = false;
    resultsTable.hidden    = true;
    tableHeaderBar.hidden  = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PROGRESS BAR
  ═══════════════════════════════════════════════════════════════════════════ */

  function showProgress(done, total) {
    progressWrap.hidden = false;
    _updateProgress(done, total);
  }

  function _updateProgress(done, total) {
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBar.style.width = pct + "%";
    progressText.textContent =
      "Processing " + done.toLocaleString() + " / " + total.toLocaleString() + " files…";
  }

  function hideProgress() {
    progressWrap.hidden = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     FILE REGISTRATION
  ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Register a single image file into allFiles.
   * De-duplicates by path.
   * @param {string}   path   – relative path (used as unique key)
   * @param {string}   name   – bare filename
   * @param {File|null} file  – browser File object (may be null)
   * @returns {boolean} true if newly added
   */
  function registerFile(path, name, file) {
    // Fast de-duplication using a Set would be better for very large sets,
    // but the existing API uses the array so we scan only new batches.
    var r    = Validator.validateFilename(name);
    var year = r.valid ? extractYear(name) : null;
    allFiles.push({
      path:   path,
      name:   name,
      valid:  r.valid,
      reason: r.reason,
      year:   year,
      file:   file || null,
    });
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PATH A — <input> FileList  (both "Browse files" & "Browse folder")
  ═══════════════════════════════════════════════════════════════════════════ */

  function processFileList(fileList) {
    // Filter to image files only, upfront
    var images = [];
    for (var i = 0; i < fileList.length; i++) {
      if (isImage(fileList[i].name)) images.push(fileList[i]);
    }

    if (images.length === 0) {
      if (allFiles.length === 0) setEmpty("No image files found. Try a different selection.");
      return;
    }

    // Build a dedup set from existing paths for O(1) lookup
    var existingPaths = buildPathSet();

    // Filter already-seen files before showing progress
    var newImages = images.filter(function (f) {
      var path = f.webkitRelativePath || f.name;
      return !existingPaths.has(path);
    });

    if (newImages.length === 0) {
      updateStats(); renderPreviewGrid(true); renderTable(); syncAgeSection();
      return;
    }

    showProgress(0, newImages.length);
    _processInputBatch(newImages, 0);
  }

  function _processInputBatch(images, offset) {
    var end = Math.min(offset + PROCESS_CHUNK, images.length);
    for (var i = offset; i < end; i++) {
      var f    = images[i];
      var path = f.webkitRelativePath || f.name;
      var name = path.split("/").pop();
      registerFile(path, name, f);
    }
    _updateProgress(end, images.length);

    if (end < images.length) {
      // Yield to the browser between chunks so the UI stays responsive
      setTimeout(function () { _processInputBatch(images, end); }, 0);
    } else {
      hideProgress();
      _afterProcessing();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PATH B — Drag-and-drop via FileSystem API
  ═══════════════════════════════════════════════════════════════════════════ */

  /** Read all entries from a DirectoryReader, looping past the 100-entry limit. */
  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) {
          if (batch.length === 0) { resolve(all); }
          else { for (var i = 0; i < batch.length; i++) all.push(batch[i]); next(); }
        }, reject);
      })();
    });
  }

  /** Wrap entry.file() in a Promise that resolves to null on failure. */
  function fileFromEntry(entry) {
    return new Promise(function (resolve) {
      try { entry.file(resolve, function () { resolve(null); }); }
      catch (_) { resolve(null); }
    });
  }

  /**
   * Recursively walk a FileSystemEntry tree.
   * Returns a flat Promise<Array<{path, name, file}>> of all images found.
   */
  function walkEntry(entry, parentPath) {
    var entryPath = parentPath ? parentPath + "/" + entry.name : entry.name;

    if (entry.isFile) {
      if (!isImage(entry.name)) return Promise.resolve([]);
      return fileFromEntry(entry).then(function (file) {
        return [{ path: entryPath, name: entry.name, file: file }];
      });
    }

    if (entry.isDirectory) {
      var reader = entry.createReader();
      return readAllEntries(reader)
        .then(function (children) {
          return Promise.all(children.map(function (child) {
            return walkEntry(child, entryPath);
          }));
        })
        .then(function (arrays) {
          // Flatten
          var flat = [];
          for (var i = 0; i < arrays.length; i++)
            for (var j = 0; j < arrays[i].length; j++)
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

    // Fallback for browsers without FileSystem API
    if (!items || items.length === 0 ||
        typeof items[0].webkitGetAsEntry !== "function") {
      processFileList(e.dataTransfer.files);
      return;
    }

    // ── SYNCHRONOUS: capture entries before event returns ─────────────────
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

    // ── ASYNC: walk the tree ──────────────────────────────────────────────
    Promise.all(entries.map(function (entry) {
      return walkEntry(entry, "");
    }))
      .then(function (arrays) {
        var found = [];
        for (var i = 0; i < arrays.length; i++)
          for (var j = 0; j < arrays[i].length; j++)
            found.push(arrays[i][j]);

        if (found.length === 0) {
          if (allFiles.length === 0) setEmpty("No image files found in the dropped folder.");
          else _afterProcessing();
          return;
        }

        // De-duplicate against existing
        var existingPaths = buildPathSet();
        var newItems = found.filter(function (x) { return !existingPaths.has(x.path); });

        if (newItems.length === 0) { _afterProcessing(); return; }

        showProgress(0, newItems.length);
        _processDragBatch(newItems, 0);
      })
      .catch(function (err) {
        console.error("Drag-drop folder scan failed:", err);
        setEmpty("Error reading folder. Please use the Browse folder button instead.");
      });
  }

  function _processDragBatch(items, offset) {
    var end = Math.min(offset + PROCESS_CHUNK, items.length);
    for (var i = offset; i < end; i++) {
      registerFile(items[i].path, items[i].name, items[i].file);
    }
    _updateProgress(end, items.length);

    if (end < items.length) {
      setTimeout(function () { _processDragBatch(items, end); }, 0);
    } else {
      hideProgress();
      _afterProcessing();
    }
  }

  /** Build a Set of all currently-known paths for O(1) de-duplication. */
  function buildPathSet() {
    var s = new Set();
    for (var i = 0; i < allFiles.length; i++) s.add(allFiles[i].path);
    return s;
  }

  /** Called after any processing batch is fully complete. */
  function _afterProcessing() {
    updateStats();
    renderPreviewGrid(true);
    renderTable();
    syncAgeSection();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     STATS
  ═══════════════════════════════════════════════════════════════════════════ */

  function updateStats() {
    var total   = allFiles.length;
    var valid   = 0;
    for (var i = 0; i < allFiles.length; i++) if (allFiles[i].valid) valid++;
    var invalid = total - valid;

    cntTotal.textContent   = total.toLocaleString();
    cntValid.textContent   = valid.toLocaleString();
    cntInvalid.textContent = invalid.toLocaleString();
    statsEl.hidden   = (total === 0);
    actionsEl.hidden = (total === 0);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     AGE CALCULATION & GROUPING
  ═══════════════════════════════════════════════════════════════════════════ */

  /** Show/hide the age section based on whether there are valid dated images. */
  function syncAgeSection() {
    var hasDated = allFiles.some(function (f) { return f.valid && f.year !== null; });
    ageSectionEl.hidden = !hasDated;
    if (hasDated) renderAgeGroups();
  }

  function renderAgeGroups() {
    var ref = getRef();

    if (!ref) {
      ageGroupsWrap.hidden = true;
      ageHintEl.hidden     = false;
      return;
    }
    ageHintEl.hidden = true;

    // Build group map: age → array of files
    var groups = Object.create(null);
    var datedCount = 0;
    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i];
      if (!f.valid || f.year === null) continue;
      datedCount++;
      var age = calcAge(f.year, ref);
      if (!groups[age]) groups[age] = [];
      groups[age].push(f);
    }

    if (datedCount === 0) { ageGroupsWrap.hidden = true; return; }

    var ages = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });

    ageGroupsWrap.hidden = false;
    cntGroupsEl.textContent = ages.length.toLocaleString();
    ageRangeEl.textContent  = ages[0] + " – " + ages[ages.length - 1];
    cntDatedEl.textContent  = datedCount.toLocaleString();

    var html = "";
    for (var ai = 0; ai < ages.length; ai++) {
      var age    = ages[ai];
      var items  = groups[age];
      var count  = items.length;

      // Show up to 4 sample filenames
      var samples = "";
      var limit = Math.min(4, count);
      for (var si = 0; si < limit; si++) {
        samples += '<span class="age-sample">' + escHtml(items[si].name) + '</span>';
      }
      if (count > limit) {
        samples += '<span class="age-more">+' + (count - limit).toLocaleString() + ' more</span>';
      }

      html +=
        '<div class="age-group-card">' +
          '<div class="age-group-row">' +
            '<span class="age-group-label">' + age + ' years old</span>' +
            '<span class="age-group-count">' +
              count.toLocaleString() + ' image' + (count !== 1 ? 's' : '') +
            '</span>' +
          '</div>' +
          '<div class="age-group-samples">' + samples + '</div>' +
        '</div>';
    }
    ageGroupsEl.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     IMAGE PREVIEW GRID  (lazy-loaded, infinite-scroll)
  ═══════════════════════════════════════════════════════════════════════════ */

  function _getPreviewFiles() {
    if (currentPreviewFilter === "valid")
      return allFiles.filter(function (f) { return f.valid; });
    if (currentPreviewFilter === "invalid")
      return allFiles.filter(function (f) { return !f.valid; });
    return allFiles;
  }

  /**
   * Render (or re-render) the preview grid.
   * @param {boolean} reset – true to clear existing cards and start fresh
   */
  function renderPreviewGrid(reset) {
    if (reset) {
      previewRenderedCount = 0;
      previewGrid.innerHTML = "";
      // Tear down old observers
      if (thumbObserver)    { thumbObserver.disconnect();    thumbObserver    = null; }
      if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
    }

    filteredPreview = _getPreviewFiles();

    if (filteredPreview.length === 0) {
      previewSection.hidden = true;
      return;
    }

    previewSection.hidden = false;
    previewCountLabel.textContent =
      filteredPreview.length.toLocaleString() +
      " image" + (filteredPreview.length !== 1 ? "s" : "");

    // ── Lazy thumbnail observer ───────────────────────────────────────────
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var card = entry.target;
        thumbObserver.unobserve(card);
        if (card.dataset.loaded) return;
        card.dataset.loaded = "1";

        var idx = parseInt(card.dataset.idx, 10);
        var f   = filteredPreview[idx];
        if (!f || !f.file) return;

        var img = card.querySelector(".thumb-img");
        if (!img) return;

        var url = URL.createObjectURL(f.file);
        img.onload  = function () { img.classList.add("loaded"); };
        img.onerror = function () {
          img.parentNode.classList.add("thumb-error");
          img.parentNode.innerHTML = '<span class="thumb-ext">' +
            escHtml(f.name.slice(f.name.lastIndexOf(".") + 1).toUpperCase()) + '</span>';
        };
        img.src = url;
      });
    }, { rootMargin: "300px" });

    // ── Infinite-scroll sentinel observer ────────────────────────────────
    sentinelObserver = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && previewRenderedCount < filteredPreview.length) {
        _appendPreviewCards();
      }
    }, { rootMargin: "400px" });
    sentinelObserver.observe(previewSentinel);

    // Render initial batch
    _appendPreviewCards();
  }

  /** Append the next PREVIEW_CHUNK cards to the grid. */
  function _appendPreviewCards() {
    var start  = previewRenderedCount;
    var end    = Math.min(start + PREVIEW_CHUNK, filteredPreview.length);
    if (start >= filteredPreview.length) return;

    var frag = document.createDocumentFragment();

    for (var i = start; i < end; i++) {
      var f    = filteredPreview[i];
      var card = document.createElement("div");
      card.className   = "preview-card " + (f.valid ? "pc-valid" : "pc-invalid");
      card.dataset.idx = i;
      card.setAttribute("role", "listitem");

      // ── Thumbnail ────────────────────────────────────────────────────
      var thumbWrap = document.createElement("div");
      thumbWrap.className = "thumb-wrap";

      if (f.file) {
        var img = document.createElement("img");
        img.className = "thumb-img";
        img.alt = f.name;
        // src is intentionally blank — set by thumbObserver when card enters viewport
        thumbWrap.appendChild(img);
        thumbObserver.observe(card);
      } else {
        // No File object (rare — only possible if entry.file() failed during drag-drop)
        var ext = f.name.lastIndexOf(".") !== -1
          ? f.name.slice(f.name.lastIndexOf(".") + 1).toUpperCase()
          : "IMG";
        thumbWrap.innerHTML = '<span class="thumb-ext">' + escHtml(ext) + '</span>';
        thumbWrap.classList.add("thumb-error");
      }

      // ── Status pill (absolute-positioned over thumbnail) ─────────────
      var pill = document.createElement("span");
      pill.className   = "thumb-pill " + (f.valid ? "tp-valid" : "tp-invalid");
      pill.textContent = f.valid ? "✅" : "❌";
      thumbWrap.appendChild(pill);

      // ── Info ─────────────────────────────────────────────────────────
      var info = document.createElement("div");
      info.className = "thumb-info";

      var nameEl = document.createElement("div");
      nameEl.className   = "thumb-name";
      nameEl.title       = f.path;
      nameEl.textContent = f.name;

      var statusEl = document.createElement("div");
      statusEl.className   = "thumb-status " + (f.valid ? "ts-valid" : "ts-invalid");
      statusEl.textContent = f.valid ? "Valid" : "Invalid";

      info.appendChild(nameEl);
      info.appendChild(statusEl);

      if (!f.valid) {
        var reasonEl = document.createElement("div");
        reasonEl.className   = "thumb-reason";
        reasonEl.textContent = f.reason;
        info.appendChild(reasonEl);
      }

      card.appendChild(thumbWrap);
      card.appendChild(info);
      frag.appendChild(card);
    }

    previewGrid.appendChild(frag);
    previewRenderedCount = end;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     VALIDATION TABLE  (paginated)
  ═══════════════════════════════════════════════════════════════════════════ */

  function _getTableFiles() {
    if (currentTableFilter === "valid")
      return allFiles.filter(function (f) { return f.valid; });
    if (currentTableFilter === "invalid")
      return allFiles.filter(function (f) { return !f.valid; });
    return allFiles;
  }

  function renderTable() {
    filteredTable = _getTableFiles();
    var ref       = getRef();

    if (filteredTable.length === 0) {
      setEmpty(
        allFiles.length === 0
          ? "Upload image files or drop a folder above to validate filenames."
          : "No files match the selected filter."
      );
      return;
    }

    var totalPages = Math.ceil(filteredTable.length / TABLE_PAGE_SIZE);
    if (currentTablePage > totalPages) currentTablePage = 1;

    var start    = (currentTablePage - 1) * TABLE_PAGE_SIZE;
    var end      = Math.min(start + TABLE_PAGE_SIZE, filteredTable.length);
    var pageRows = filteredTable.slice(start, end);

    var html = "";
    for (var i = 0; i < pageRows.length; i++) {
      var f  = pageRows[i];
      var bc = f.valid ? "valid"   : "invalid";
      var sl = f.valid ? "✅ Valid" : "❌ Invalid";
      var rc = f.valid ? "reason"  : "reason err";

      var ageCell = "<span class='age-dash'>—</span>";
      if (f.valid && f.year !== null && ref) {
        var age = calcAge(f.year, ref);
        ageCell = '<span class="age-val">' + age + ' yrs</span>';
      }

      html +=
        "<tr>" +
          '<td class="filename" title="' + escHtml(f.path) + '">' + escHtml(f.name) + "</td>" +
          "<td><span class=\"badge " + bc + "\"><span class=\"dot\"></span>" + sl + "</span></td>" +
          '<td class="' + rc + '">' + escHtml(f.reason) + "</td>" +
          '<td class="age-col">' + ageCell + "</td>" +
        "</tr>";
    }

    resultsBody.innerHTML = html;
    resultsTable.hidden   = false;
    emptyState.hidden     = true;
    tableHeaderBar.hidden = false;

    tablePageLabel.textContent =
      "Showing " + (start + 1).toLocaleString() + "–" +
      end.toLocaleString() + " of " +
      filteredTable.length.toLocaleString();

    pageNumEl.textContent    = currentTablePage + " / " + totalPages;
    pagePrevBtn.disabled     = (currentTablePage <= 1);
    pageNextBtn.disabled     = (currentTablePage >= totalPages);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CLEAR
  ═══════════════════════════════════════════════════════════════════════════ */

  function clearAll() {
    allFiles             = [];
    filteredTable        = [];
    filteredPreview      = [];
    currentTablePage     = 1;
    currentTableFilter   = "all";
    currentPreviewFilter = "all";
    previewRenderedCount = 0;

    filterSel.value        = "all";
    previewFilterSel.value = "all";
    refAgeInput.value      = "";
    refYearInput.value     = "";

    previewGrid.innerHTML  = "";
    resultsBody.innerHTML  = "";

    if (thumbObserver)    { thumbObserver.disconnect();    thumbObserver    = null; }
    if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }

    statsEl.hidden        = true;
    actionsEl.hidden      = true;
    ageSectionEl.hidden   = true;
    previewSection.hidden = true;
    tableHeaderBar.hidden = true;

    setEmpty("Upload image files or drop a folder above to validate filenames.");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CSV EXPORT  (now includes Year and Age columns)
  ═══════════════════════════════════════════════════════════════════════════ */

  function downloadReport() {
    if (!allFiles.length) { alert("No files to export."); return; }
    var ref = getRef();
    var csvRows = [["Path", "Filename", "Status", "Reason", "Year", "Age"]];

    for (var i = 0; i < allFiles.length; i++) {
      var f   = allFiles[i];
      var age = (f.valid && f.year !== null && ref) ? calcAge(f.year, ref) : "";
      csvRows.push([f.path, f.name, f.valid ? "Valid" : "Invalid",
                    f.reason, f.year != null ? f.year : "", age]);
    }

    var csv = csvRows.map(function (row) {
      return row.map(function (c) {
        return '"' + String(c).replace(/"/g, '""') + '"';
      }).join(",");
    }).join("\n");

    var a = document.createElement("a");
    a.href     = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = "filename_validation_report.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENT WIRING
  ═══════════════════════════════════════════════════════════════════════════ */

  // Upload buttons
  browseFilesBtn.addEventListener("click", function (e) {
    e.stopPropagation(); fileInput.click();
  });
  browseFolderBtn.addEventListener("click", function (e) {
    e.stopPropagation(); folderInput.click();
  });
  dropZone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener("change",   function (e) { processFileList(e.target.files); e.target.value = ""; });
  folderInput.addEventListener("change", function (e) { processFileList(e.target.files); e.target.value = ""; });

  // Drag-drop
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop",     function (e) { e.preventDefault(); });
  dropZone.addEventListener("dragenter", function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragover",  function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", function (e) {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", handleDrop);

  // Table filter & pagination
  filterSel.addEventListener("change", function () {
    currentTableFilter = filterSel.value;
    currentTablePage   = 1;
    renderTable();
  });
  pagePrevBtn.addEventListener("click", function () {
    if (currentTablePage > 1) { currentTablePage--; renderTable(); }
  });
  pageNextBtn.addEventListener("click", function () {
    currentTablePage++;
    renderTable();
  });

  // Preview filter
  previewFilterSel.addEventListener("change", function () {
    currentPreviewFilter = previewFilterSel.value;
    renderPreviewGrid(true);
  });

  // Age inputs — recalculate on change
  refAgeInput.addEventListener("input",  function () { renderAgeGroups(); renderTable(); });
  refYearInput.addEventListener("input", function () { renderAgeGroups(); renderTable(); });

  // Actions
  clearBtn.addEventListener("click",    clearAll);
  downloadBtn.addEventListener("click", downloadReport);

})();
