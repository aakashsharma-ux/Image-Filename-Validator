/**
 * app.js  (v3)
 * ============
 * All v2 features preserved. Key additions:
 *
 *  PATH PARSING
 *    • personId    — root folder name (first segment of webkitRelativePath)
 *    • folderName  — immediate parent folder of the file
 *    • isMainFolder— true only when the file sits directly in the root folder
 *                    (path depth === 1, i.e. RootFolder/file.jpg)
 *
 *  VALIDATION TABLE
 *    • New columns: Person ID | Folder | Filename | Status | Error Type | Error Description
 *
 *  AGE CALCULATION (CRITICAL SCOPE RULE)
 *    • ✅ Uses ONLY files where isMainFolder === true
 *    • ❌ Ignores all subfolders (including truth_images and any others)
 *
 *  AGE RANGE GENERATOR
 *    • Fully independent module — no dependency on uploaded files
 *    • Input: age + year → Output: timeline from 21 down to 12
 *
 *  PERFORMANCE
 *    • Chunked async processing (PROCESS_CHUNK = 500)
 *    • Lazy preview thumbnails via IntersectionObserver
 *    • Infinite-scroll preview with sentinel observer
 *    • Table pagination (100 rows/page)
 *    • O(1) de-duplication via Set
 *
 * Depends on: validator.js (must load first)
 */

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════════ */

  var IMAGE_EXTS = {
    jpg:1, jpeg:1, png:1, gif:1, webp:1,
    bmp:1, svg:1, tiff:1, tif:1, heic:1, heif:1, avif:1,
  };

  var TABLE_PAGE_SIZE  = 100;
  var PREVIEW_CHUNK    = 60;
  var PROCESS_CHUNK    = 500;

  /* ═══════════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════════ */

  /**
   * Central file record:
   * {
   *   path        : string   — full relative path (de-dup key)
   *   name        : string   — bare filename
   *   personId    : string   — root folder name
   *   folderName  : string   — immediate parent folder name
   *   isMainFolder: boolean  — true when file is directly inside root folder
   *   valid       : boolean
   *   errorType   : string   — "VALID" | "CASE_ERROR" | "MONTH_ERROR" | …
   *   reason      : string
   *   year        : number|null
   *   file        : File|null
   * }
   */
  var allFiles = [];

  var filteredTable    = [];
  var filteredPreview  = [];
  var currentTablePage   = 1;
  var currentTableFilter = "all";
  var currentPreviewFilter = "all";
  var previewRenderedCount = 0;
  var thumbObserver    = null;
  var sentinelObserver = null;

  /* ═══════════════════════════════════════════════════════════════
     DOM REFS
  ═══════════════════════════════════════════════════════════════ */

  var dropZone          = document.getElementById("drop-zone");
  var fileInput         = document.getElementById("file-input");
  var folderInput       = document.getElementById("folder-input");
  var browseFilesBtn    = document.getElementById("browse-files-btn");
  var browseFolderBtn   = document.getElementById("browse-folder-btn");
  var progressWrap      = document.getElementById("progress-wrap");
  var progressBar       = document.getElementById("progress-bar");
  var progressText      = document.getElementById("progress-text");
  var statsEl           = document.getElementById("stats");
  var actionsEl         = document.getElementById("actions");
  var cntTotal          = document.getElementById("cnt-total");
  var cntValid          = document.getElementById("cnt-valid");
  var cntInvalid        = document.getElementById("cnt-invalid");
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
  // Age calc section
  var ageSectionEl      = document.getElementById("age-section");
  var refAgeInput       = document.getElementById("ref-age");
  var refYearInput      = document.getElementById("ref-year");
  var ageGroupsWrap     = document.getElementById("age-groups-wrap");
  var ageGroupsEl       = document.getElementById("age-groups");
  var cntGroupsEl       = document.getElementById("cnt-groups");
  var ageRangeEl        = document.getElementById("age-range");
  var cntDatedEl        = document.getElementById("cnt-dated");
  var cntMainEl         = document.getElementById("cnt-main-folder");
  var ageHintEl         = document.getElementById("age-hint");
  var mainFolderNote    = document.getElementById("main-folder-note");
  var sheetsExportWrap  = document.getElementById("sheets-export-wrap");
  var sheetsGridEl      = document.getElementById("sheets-grid");
  // Preview
  var previewSection    = document.getElementById("preview-section");
  var previewGrid       = document.getElementById("preview-grid");
  var previewSentinel   = document.getElementById("preview-sentinel");
  var previewCountLabel = document.getElementById("preview-count-label");
  var previewFilterSel  = document.getElementById("preview-filter");
  // Age range generator
  var ageRangeSection   = document.getElementById("age-range-section");
  var arAgeInput        = document.getElementById("ar-age");
  var arYearInput       = document.getElementById("ar-year");
  var arGenerateBtn     = document.getElementById("ar-generate-btn");
  var arClearBtn        = document.getElementById("ar-clear-btn");
  var arOutput          = document.getElementById("ar-output");
  var arCopyBtn         = document.getElementById("ar-copy-btn");

  /* ═══════════════════════════════════════════════════════════════
     UTILITIES
  ═══════════════════════════════════════════════════════════════ */

  function isImage(filename) {
    var dot = filename.lastIndexOf(".");
    return dot !== -1 && !!IMAGE_EXTS[filename.slice(dot + 1).toLowerCase()];
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function extractYear(name) {
    var stem = Validator.stripExtension(name);
    var m = stem.match(/^[a-z]{3}_\d{2}_(\d{4})$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function getRef() {
    var a = parseInt(refAgeInput.value, 10);
    var y = parseInt(refYearInput.value, 10);
    return (!isNaN(a) && !isNaN(y)) ? { age: a, year: y } : null;
  }

  function calcAge(imageYear, ref) {
    return ref.age + (imageYear - ref.year);
  }

  function setEmpty(msg) {
    emptyState.textContent = msg;
    emptyState.hidden      = false;
    resultsTable.hidden    = true;
    tableHeaderBar.hidden  = true;
  }

  /**
   * Parse a file's webkitRelativePath into structured metadata.
   *
   * Path examples:
   *   "MyFolder/image.jpg"              → personId="MyFolder", folderName="MyFolder", isMainFolder=true
   *   "MyFolder/truth_images/img.jpg"   → personId="MyFolder", folderName="truth_images", isMainFolder=false
   *   "MyFolder/sub/deep/img.jpg"       → personId="MyFolder", folderName="deep", isMainFolder=false
   *   "image.jpg"  (no relative path)   → personId="—",        folderName="—",        isMainFolder=true
   *
   * @param {string} relativePath — file.webkitRelativePath or bare name
   * @returns {{ personId, folderName, isMainFolder }}
   */
  function parsePath(relativePath) {
    var segments = relativePath.split("/");
    // segments: [rootFolder, ...subfolders, filename]
    if (segments.length <= 1) {
      // Bare filename — no folder info
      return { personId: "—", folderName: "—", isMainFolder: true };
    }
    var personId    = segments[0];
    // folderName = the immediate parent folder (segment before filename)
    var folderName  = segments[segments.length - 2];
    // isMainFolder = only one folder level above the file (depth 1)
    var isMainFolder = (segments.length === 2);
    return { personId: personId, folderName: folderName, isMainFolder: isMainFolder };
  }

  /* ═══════════════════════════════════════════════════════════════
     PROGRESS BAR
  ═══════════════════════════════════════════════════════════════ */

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

  function hideProgress() { progressWrap.hidden = true; }

  /* ═══════════════════════════════════════════════════════════════
     FILE REGISTRATION
  ═══════════════════════════════════════════════════════════════ */

  /**
   * Register one image file into allFiles.
   * @param {string}   path  — relative path (de-dup key + display)
   * @param {string}   name  — bare filename
   * @param {File|null} file — browser File object for thumbnails
   */
  function registerFile(path, name, file) {
    var meta = parsePath(path);
    var r    = Validator.validateFilename(name);
    var year = r.valid ? extractYear(name) : null;
    allFiles.push({
      path:         path,
      name:         name,
      personId:     meta.personId,
      folderName:   meta.folderName,
      isMainFolder: meta.isMainFolder,
      valid:        r.valid,
      errorType:    r.errorType,
      reason:       r.reason,
      year:         year,
      file:         file || null,
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     PATH A — <input> FileList  (Browse files / Browse folder)
  ═══════════════════════════════════════════════════════════════ */

  function processFileList(fileList) {
    var images = [];
    for (var i = 0; i < fileList.length; i++) {
      if (isImage(fileList[i].name)) images.push(fileList[i]);
    }
    if (images.length === 0) {
      if (allFiles.length === 0) setEmpty("No image files found. Try a different selection.");
      return;
    }
    var existingPaths = buildPathSet();
    var newImages = images.filter(function (f) {
      return !existingPaths.has(f.webkitRelativePath || f.name);
    });
    if (newImages.length === 0) { _afterProcessing(); return; }
    showProgress(0, newImages.length);
    _processInputBatch(newImages, 0);
  }

  function _processInputBatch(images, offset) {
    var end = Math.min(offset + PROCESS_CHUNK, images.length);
    for (var i = offset; i < end; i++) {
      var f    = images[i];
      var path = f.webkitRelativePath || f.name;
      registerFile(path, path.split("/").pop(), f);
    }
    _updateProgress(end, images.length);
    if (end < images.length) {
      setTimeout(function () { _processInputBatch(images, end); }, 0);
    } else {
      hideProgress();
      _afterProcessing();
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PATH B — Drag-and-drop via FileSystem API
  ═══════════════════════════════════════════════════════════════ */

  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) {
          if (batch.length === 0) resolve(all);
          else { for (var i = 0; i < batch.length; i++) all.push(batch[i]); next(); }
        }, reject);
      })();
    });
  }

  function fileFromEntry(entry) {
    return new Promise(function (resolve) {
      try { entry.file(resolve, function () { resolve(null); }); }
      catch (_) { resolve(null); }
    });
  }

  function walkEntry(entry, parentPath) {
    var entryPath = parentPath ? parentPath + "/" + entry.name : entry.name;
    if (entry.isFile) {
      if (!isImage(entry.name)) return Promise.resolve([]);
      return fileFromEntry(entry).then(function (file) {
        return [{ path: entryPath, name: entry.name, file: file }];
      });
    }
    if (entry.isDirectory) {
      return readAllEntries(entry.createReader())
        .then(function (children) {
          return Promise.all(children.map(function (c) { return walkEntry(c, entryPath); }));
        })
        .then(function (arrays) {
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
    if (!items || items.length === 0 ||
        typeof items[0].webkitGetAsEntry !== "function") {
      processFileList(e.dataTransfer.files);
      return;
    }
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
    Promise.all(entries.map(function (e) { return walkEntry(e, ""); }))
      .then(function (arrays) {
        var found = [];
        for (var i = 0; i < arrays.length; i++)
          for (var j = 0; j < arrays[i].length; j++)
            found.push(arrays[i][j]);
        if (found.length === 0) {
          if (allFiles.length === 0) setEmpty("No image files found.");
          else _afterProcessing();
          return;
        }
        var existingPaths = buildPathSet();
        var newItems = found.filter(function (x) { return !existingPaths.has(x.path); });
        if (newItems.length === 0) { _afterProcessing(); return; }
        showProgress(0, newItems.length);
        _processDragBatch(newItems, 0);
      })
      .catch(function (err) {
        console.error("Drop scan failed:", err);
        setEmpty("Error reading folder. Please use the Browse folder button.");
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

  function buildPathSet() {
    var s = new Set();
    for (var i = 0; i < allFiles.length; i++) s.add(allFiles[i].path);
    return s;
  }

  function _afterProcessing() {
    updateStats();
    renderPreviewGrid(true);
    renderTable();
    syncAgeSection();
  }

  /* ═══════════════════════════════════════════════════════════════
     STATS
  ═══════════════════════════════════════════════════════════════ */

  function updateStats() {
    var total = allFiles.length, valid = 0;
    for (var i = 0; i < allFiles.length; i++) if (allFiles[i].valid) valid++;
    cntTotal.textContent   = total.toLocaleString();
    cntValid.textContent   = valid.toLocaleString();
    cntInvalid.textContent = (total - valid).toLocaleString();
    statsEl.hidden   = (total === 0);
    actionsEl.hidden = (total === 0);
  }

  /* ═══════════════════════════════════════════════════════════════
     AGE CALCULATION  ← MAIN FOLDER ONLY
  ═══════════════════════════════════════════════════════════════ */

  function syncAgeSection() {
    // Only consider main-folder files for age calculation
    var mainFolderFiles = allFiles.filter(function (f) { return f.isMainFolder; });
    var hasDated = mainFolderFiles.some(function (f) { return f.valid && f.year !== null; });
    ageSectionEl.hidden = !hasDated;
    // Update the "N files from main folder" note
    if (cntMainEl) {
      cntMainEl.textContent = mainFolderFiles.length.toLocaleString() +
        " file" + (mainFolderFiles.length !== 1 ? "s" : "") + " from main folder";
    }
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

    // ── CRITICAL: only main folder files ────────────────────
    var groups = Object.create(null);
    var datedCount = 0;
    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i];
      if (!f.isMainFolder) continue;   // ← skip ALL subfolders
      if (!f.valid || f.year === null) continue;
      datedCount++;
      var age = calcAge(f.year, ref);
      if (!groups[age]) groups[age] = [];
      groups[age].push(f);
    }

    if (datedCount === 0) { ageGroupsWrap.hidden = true; return; }

    var ages = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    ageGroupsWrap.hidden    = false;
    cntGroupsEl.textContent = ages.length.toLocaleString();
    ageRangeEl.textContent  = ages[0] + " – " + ages[ages.length - 1];
    cntDatedEl.textContent  = datedCount.toLocaleString();

    // ── Compact horizontal strip (fixed 21 → 12, always all columns) ──
    var headerCells = "";
    var countCells  = "";
    for (var ci = 0; ci < SHEETS_AGES.length; ci++) {
      var a      = SHEETS_AGES[ci];
      var count  = groups[a] ? groups[a].length : 0;
      var hasVal = count > 0;
      headerCells +=
        '<div class="agb-head" title="' + a + ' years">' +
          '<span class="agb-age-num">' + a + '</span>' +
          '<span class="agb-age-unit"> yea</span>' +
          '<span class="agb-filter" aria-hidden="true">&#8801;</span>' +
        '</div>';
      countCells +=
        '<div class="agb-count ' + (hasVal ? 'agb-has-val' : 'agb-zero') + '">' +
          '<span class="agb-num">' + count + '</span>' +
          '<span class="agb-arrow" aria-hidden="true">&#9660;</span>' +
        '</div>';
    }
    ageGroupsEl.innerHTML =
      '<div class="agb-wrap">' +
        '<div class="agb-row agb-row-head">' + headerCells + '</div>' +
        '<div class="agb-row agb-row-count">' + countCells  + '</div>' +
      '</div>';

  }

  /* ═══════════════════════════════════════════════════════════════
     IMAGE PREVIEW GRID  (lazy IntersectionObserver + sentinel)
  ═══════════════════════════════════════════════════════════════ */

  function _getPreviewFiles() {
    if (currentPreviewFilter === "valid")   return allFiles.filter(function (f) { return  f.valid; });
    if (currentPreviewFilter === "invalid") return allFiles.filter(function (f) { return !f.valid; });
    return allFiles;
  }

  function renderPreviewGrid(reset) {
    if (reset) {
      previewRenderedCount = 0;
      previewGrid.innerHTML = "";
      if (thumbObserver)    { thumbObserver.disconnect();    thumbObserver    = null; }
      if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
    }
    filteredPreview = _getPreviewFiles();
    if (filteredPreview.length === 0) { previewSection.hidden = true; return; }
    previewSection.hidden = false;
    previewCountLabel.textContent =
      filteredPreview.length.toLocaleString() + " image" + (filteredPreview.length !== 1 ? "s" : "");

    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var card = entry.target;
        thumbObserver.unobserve(card);
        if (card.dataset.loaded) return;
        card.dataset.loaded = "1";
        var f = filteredPreview[parseInt(card.dataset.idx, 10)];
        if (!f || !f.file) return;
        var img = card.querySelector(".thumb-img");
        if (!img) return;
        var url = URL.createObjectURL(f.file);
        img.onload  = function () { img.classList.add("loaded"); };
        img.onerror = function () {
          img.parentNode.classList.add("thumb-error");
          img.parentNode.innerHTML =
            '<span class="thumb-ext">' + escHtml(f.name.slice(f.name.lastIndexOf(".")+1).toUpperCase()) + '</span>';
        };
        img.src = url;
      });
    }, { rootMargin: "300px" });

    sentinelObserver = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && previewRenderedCount < filteredPreview.length) {
        _appendPreviewCards();
      }
    }, { rootMargin: "400px" });
    sentinelObserver.observe(previewSentinel);
    _appendPreviewCards();
  }

  function _appendPreviewCards() {
    var start = previewRenderedCount;
    var end   = Math.min(start + PREVIEW_CHUNK, filteredPreview.length);
    if (start >= filteredPreview.length) return;
    var frag = document.createDocumentFragment();
    for (var i = start; i < end; i++) {
      var f    = filteredPreview[i];
      var card = document.createElement("div");
      card.className   = "preview-card " + (f.valid ? "pc-valid" : "pc-invalid");
      card.dataset.idx = i;
      card.setAttribute("role", "listitem");

      var thumbWrap = document.createElement("div");
      thumbWrap.className = "thumb-wrap";
      if (f.file) {
        var img = document.createElement("img");
        img.className = "thumb-img"; img.alt = f.name;
        thumbWrap.appendChild(img);
        thumbObserver.observe(card);
      } else {
        var ext = f.name.lastIndexOf(".") !== -1 ? f.name.slice(f.name.lastIndexOf(".")+1).toUpperCase() : "IMG";
        thumbWrap.innerHTML = '<span class="thumb-ext">' + escHtml(ext) + '</span>';
        thumbWrap.classList.add("thumb-error");
      }
      var pill = document.createElement("span");
      pill.className   = "thumb-pill " + (f.valid ? "tp-valid" : "tp-invalid");
      pill.textContent = f.valid ? "✅" : "❌";
      thumbWrap.appendChild(pill);

      // Badge for main-folder vs subfolder
      if (!f.isMainFolder) {
        var subBadge = document.createElement("span");
        subBadge.className   = "thumb-subfolder-badge";
        subBadge.textContent = "sub";
        subBadge.title       = "Subfolder: " + f.folderName;
        thumbWrap.appendChild(subBadge);
      }

      var info = document.createElement("div");
      info.className = "thumb-info";
      var nameEl = document.createElement("div");
      nameEl.className = "thumb-name"; nameEl.title = f.path; nameEl.textContent = f.name;
      var statusEl = document.createElement("div");
      statusEl.className   = "thumb-status " + (f.valid ? "ts-valid" : "ts-invalid");
      statusEl.textContent = f.valid ? "✅ Valid" : "❌ Invalid";
      var folderEl = document.createElement("div");
      folderEl.className   = "thumb-folder";
      folderEl.textContent = f.isMainFolder ? "📁 main" : "📂 " + f.folderName;
      info.appendChild(nameEl);
      info.appendChild(statusEl);
      info.appendChild(folderEl);
      if (!f.valid) {
        var typeEl = document.createElement("div");
        typeEl.className   = "thumb-etype";
        typeEl.textContent = f.errorType;
        var reasonEl = document.createElement("div");
        reasonEl.className   = "thumb-reason";
        reasonEl.textContent = f.reason;
        info.appendChild(typeEl);
        info.appendChild(reasonEl);
      }
      card.appendChild(thumbWrap);
      card.appendChild(info);
      frag.appendChild(card);
    }
    previewGrid.appendChild(frag);
    previewRenderedCount = end;
  }

  /* ═══════════════════════════════════════════════════════════════
     VALIDATION TABLE (paginated, extended columns)
  ═══════════════════════════════════════════════════════════════ */

  function _getTableFiles() {
    if (currentTableFilter === "valid")   return allFiles.filter(function (f) { return  f.valid; });
    if (currentTableFilter === "invalid") return allFiles.filter(function (f) { return !f.valid; });
    return allFiles;
  }

  function renderTable() {
    filteredTable = _getTableFiles();
    var ref = getRef();

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

      // Age column — only for main-folder valid files when ref is set
      var ageCell = "<span class='age-dash'>—</span>";
      if (f.isMainFolder && f.valid && f.year !== null && ref) {
        ageCell = '<span class="age-val">' + calcAge(f.year, ref) + ' yrs</span>';
      } else if (!f.isMainFolder && f.valid) {
        ageCell = '<span class="age-dash sub-excl" title="Subfolders excluded from age calc">sub</span>';
      }

      // Error type badge
      var etCell = f.valid
        ? '<span class="et-badge et-valid">VALID</span>'
        : '<span class="et-badge et-' + f.errorType.toLowerCase().replace("_","-") + '">' + escHtml(f.errorType) + '</span>';

      html +=
        "<tr class='" + (f.valid ? "row-valid" : "row-invalid") + "'>" +
          '<td class="td-pid" title="' + escHtml(f.personId) + '">'    + escHtml(f.personId)    + "</td>" +
          '<td class="td-folder" title="' + escHtml(f.folderName) + '">' + escHtml(f.folderName) + "</td>" +
          '<td class="filename" title="' + escHtml(f.path) + '">'       + escHtml(f.name)        + "</td>" +
          '<td><span class="badge ' + bc + '"><span class="dot"></span>' + sl + "</span></td>" +
          '<td class="td-etype">'  + etCell + "</td>" +
          '<td class="' + rc + '">' + escHtml(f.reason) + "</td>" +
          '<td class="age-col">'   + ageCell + "</td>" +
        "</tr>";
    }

    resultsBody.innerHTML = html;
    resultsTable.hidden   = false;
    emptyState.hidden     = true;
    tableHeaderBar.hidden = false;
    tablePageLabel.textContent =
      "Showing " + (start+1).toLocaleString() + "–" + end.toLocaleString() +
      " of " + filteredTable.length.toLocaleString();
    pageNumEl.textContent  = currentTablePage + " / " + totalPages;
    pagePrevBtn.disabled   = (currentTablePage <= 1);
    pageNextBtn.disabled   = (currentTablePage >= totalPages);
  }

  /* ═══════════════════════════════════════════════════════════════
     AGE RANGE GENERATOR  (fully independent module)
  ═══════════════════════════════════════════════════════════════ */

  var AGE_RANGE_MAX = 21;
  var AGE_RANGE_MIN = 12;

  // Fixed age columns for Google Sheets export (21 → 12, matching generator)
  var SHEETS_AGES = [21, 20, 19, 18, 17, 16, 15, 14, 13, 12];

  function generateAgeRange() {
    var inputAge  = parseInt(arAgeInput.value, 10);
    var inputYear = parseInt(arYearInput.value, 10);

    // Validate inputs
    if (isNaN(inputAge) || isNaN(inputYear)) {
      arOutput.innerHTML = '<p class="ar-error">Please enter both Age and Year.</p>';
      arOutput.hidden = false;
      arCopyBtn.hidden = true;
      return;
    }
    if (inputAge < 1 || inputAge > 120) {
      arOutput.innerHTML = '<p class="ar-error">Age must be between 1 and 120.</p>';
      arOutput.hidden = false;
      arCopyBtn.hidden = true;
      return;
    }
    if (inputYear < 1900 || inputYear > 2100) {
      arOutput.innerHTML = '<p class="ar-error">Year must be between 1900 and 2100.</p>';
      arOutput.hidden = false;
      arCopyBtn.hidden = true;
      return;
    }

    // Build timeline rows from AGE_RANGE_MAX down to AGE_RANGE_MIN
    var rows = [];
    for (var targetAge = AGE_RANGE_MAX; targetAge >= AGE_RANGE_MIN; targetAge--) {
      var yearForAge = inputYear + (targetAge - inputAge);
      rows.push({ year: yearForAge, age: targetAge, isRef: (targetAge === inputAge) });
    }

    var html = '<div class="ar-table-wrap"><table class="ar-table">' +
      '<thead><tr><th>Year</th><th>Age</th></tr></thead><tbody>';
    for (var ri = 0; ri < rows.length; ri++) {
      var r = rows[ri];
      html +=
        '<tr class="' + (r.isRef ? "ar-ref-row" : "") + '">' +
          '<td class="ar-year">' + r.year + (r.isRef ? ' <span class="ar-ref-tag">ref</span>' : '') + '</td>' +
          '<td class="ar-age">' + r.age + ' years</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';

    arOutput.innerHTML = html;
    arOutput.hidden    = false;
    arCopyBtn.hidden   = false;

    // Store plain-text version for copy
    arOutput.dataset.plain = rows.map(function (r) {
      return r.year + " — " + r.age + " years" + (r.isRef ? " (reference)" : "");
    }).join("\n");
  }

  function clearAgeRange() {
    arAgeInput.value   = "";
    arYearInput.value  = "";
    arOutput.innerHTML = "";
    arOutput.hidden    = true;
    arCopyBtn.hidden   = true;
  }

  function copyAgeRange() {
    var text = arOutput.dataset.plain || "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      arCopyBtn.textContent = "✓ Copied!";
      setTimeout(function () { arCopyBtn.textContent = "Copy"; }, 2000);
    }).catch(function () {
      // Fallback for older browsers
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      arCopyBtn.textContent = "✓ Copied!";
      setTimeout(function () { arCopyBtn.textContent = "Copy"; }, 2000);
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     CLEAR
  ═══════════════════════════════════════════════════════════════ */

  function clearAll() {
    allFiles = []; filteredTable = []; filteredPreview = [];
    currentTablePage = 1; currentTableFilter = "all"; currentPreviewFilter = "all";
    previewRenderedCount = 0;
    filterSel.value = "all"; previewFilterSel.value = "all";
    refAgeInput.value = ""; refYearInput.value = "";
    previewGrid.innerHTML = ""; resultsBody.innerHTML = "";
    if (thumbObserver)    { thumbObserver.disconnect();    thumbObserver    = null; }
    if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
    statsEl.hidden = true; actionsEl.hidden = true;
    ageSectionEl.hidden = true; previewSection.hidden = true; tableHeaderBar.hidden = true;
    if (sheetsExportWrap) { sheetsExportWrap.hidden = true; sheetsGridEl.innerHTML = ""; }
    setEmpty("Upload image files or drop a folder above to validate filenames.");
  }

  /* ═══════════════════════════════════════════════════════════════
     CSV EXPORT  (Person ID, Folder, Filename, Status, ErrorType, Reason, Year, Age)
  ═══════════════════════════════════════════════════════════════ */

  function downloadReport() {
    if (!allFiles.length) { alert("No files to export."); return; }
    var ref = getRef();
    var csvRows = [["Person ID","Folder","Filename","Status","Error Type","Error Description","Year","Age","Main Folder?"]];
    for (var i = 0; i < allFiles.length; i++) {
      var f   = allFiles[i];
      var age = (f.isMainFolder && f.valid && f.year !== null && ref) ? calcAge(f.year, ref) : "";
      csvRows.push([
        f.personId, f.folderName, f.name,
        f.valid ? "Valid" : "Invalid",
        f.errorType, f.reason,
        f.year != null ? f.year : "",
        age,
        f.isMainFolder ? "Yes" : "No",
      ]);
    }
    var csv = csvRows.map(function (row) {
      return row.map(function (c) { return '"' + String(c).replace(/"/g,'""') + '"'; }).join(",");
    }).join("\n");
    var a = document.createElement("a");
    a.href     = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"}));
    a.download = "filename_validation_report.csv";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENT WIRING
  ═══════════════════════════════════════════════════════════════ */

  browseFilesBtn.addEventListener("click",  function (e) { e.stopPropagation(); fileInput.click(); });
  browseFolderBtn.addEventListener("click", function (e) { e.stopPropagation(); folderInput.click(); });
  dropZone.addEventListener("keydown", function (e) {
    if (e.key==="Enter"||e.key===" ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change",   function (e) { processFileList(e.target.files); e.target.value=""; });
  folderInput.addEventListener("change", function (e) { processFileList(e.target.files); e.target.value=""; });

  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop",     function (e) { e.preventDefault(); });
  dropZone.addEventListener("dragenter", function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragover",  function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", function (e) {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", handleDrop);

  filterSel.addEventListener("change", function () {
    currentTableFilter = filterSel.value; currentTablePage = 1; renderTable();
  });
  pagePrevBtn.addEventListener("click", function () { if (currentTablePage>1){ currentTablePage--; renderTable(); } });
  pageNextBtn.addEventListener("click", function () { currentTablePage++; renderTable(); });
  previewFilterSel.addEventListener("change", function () {
    currentPreviewFilter = previewFilterSel.value; renderPreviewGrid(true);
  });
  refAgeInput.addEventListener("input",  function () { renderAgeGroups(); renderTable(); });
  refYearInput.addEventListener("input", function () { renderAgeGroups(); renderTable(); });
  clearBtn.addEventListener("click",    clearAll);
  downloadBtn.addEventListener("click", downloadReport);

  // Age Range Generator
  arGenerateBtn.addEventListener("click", generateAgeRange);
  arClearBtn.addEventListener("click",    clearAgeRange);
  arCopyBtn.addEventListener("click",     copyAgeRange);

  arAgeInput.addEventListener("keydown",  function (e) { if (e.key==="Enter") generateAgeRange(); });
  arYearInput.addEventListener("keydown", function (e) { if (e.key==="Enter") generateAgeRange(); });

})();
