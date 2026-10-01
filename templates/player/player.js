/*
 * Content player for converted SCORM packages (PDF and video).
 * ES5 on purpose; see scorm-api.js.
 */
(function (window, document) {
  'use strict';

  var cfg = window.SCORM_CONFIG;
  var scorm = window.ScormRuntime;
  var stage = document.getElementById('stage');
  var meterFill = document.getElementById('meter-fill');
  var meter = meterFill.parentNode;
  var statusText = document.getElementById('status-text');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var saved = scorm.start();

  // -------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 2600);
  }

  function showMessage(title, body, spinner) {
    stage.innerHTML = '';
    var m = el('div', { 'class': 'message' });
    if (spinner) m.appendChild(el('div', { 'class': 'spinner' }));
    m.appendChild(el('h2', null, title));
    if (body) m.appendChild(el('p', null, body));
    stage.appendChild(m);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Compact bitset, serialised as hex so suspend_data stays small and uses
  // only characters every LMS stores safely.
  function Bits(n) {
    this.n = n;
    this.a = [];
    for (var i = 0; i < n; i++) this.a.push(0);
  }
  Bits.prototype.set = function (i) { if (i >= 0 && i < this.n && !this.a[i]) { this.a[i] = 1; return true; } return false; };
  Bits.prototype.count = function () { var c = 0; for (var i = 0; i < this.n; i++) c += this.a[i]; return c; };
  Bits.prototype.toHex = function () {
    var out = '';
    for (var i = 0; i < this.n; i += 4) {
      var v = 0;
      for (var j = 0; j < 4; j++) if (this.a[i + j]) v |= (8 >> j);
      out += v.toString(16);
    }
    return out;
  };
  Bits.prototype.fromHex = function (hex) {
    for (var i = 0; i < hex.length; i++) {
      var v = parseInt(hex.charAt(i), 16);
      if (isNaN(v)) return;
      for (var j = 0; j < 4; j++) if (v & (8 >> j)) this.set(i * 4 + j);
    }
  };

  // suspend_data format: "v1|<hexbits>|<extra>"
  function parseSuspend(s) {
    var parts = String(s || '').split('|');
    if (parts[0] !== 'v1') return { bits: '', extra: '' };
    return { bits: parts[1] || '', extra: parts[2] || '' };
  }

  // -------------------------------------------------------------------
  // Progress + completion
  // -------------------------------------------------------------------
  var isComplete = !!saved.completed;
  var threshold = cfg.completion.mode === 'launch' ? 0 : cfg.completion.threshold / 100;

  function renderProgress(ratio) {
    var pct = isComplete ? 100 : Math.round(ratio * 100);
    meterFill.style.width = pct + '%';
    meter.setAttribute('aria-valuenow', String(pct));
    statusText.textContent = isComplete ? 'Completed' : pct + '% viewed';
    if (isComplete) document.body.className += document.body.className.indexOf('is-complete') < 0 ? ' is-complete' : '';
  }

  function markComplete() {
    if (isComplete && scorm.completed) return;
    var wasComplete = isComplete;
    isComplete = true;
    scorm.complete();
    if (!wasComplete) toast('Completed. Your progress has been recorded.');
  }

  function updateProgress(ratio, location, suspend) {
    // Save first so the immediate commit on completion includes this state.
    scorm.save(location, suspend, ratio);
    if (!isComplete && ratio + 1e-9 >= threshold) markComplete();
    renderProgress(ratio);
  }

  if (cfg.completion.mode === 'launch') markComplete();

  if (!scorm.connected) {
    // Useful when opening index.html directly for a quick check.
    setTimeout(function () { toast('Preview mode: no LMS connection, progress will not be saved.'); }, 600);
  }

  // -------------------------------------------------------------------
  // PDF player
  // -------------------------------------------------------------------
  function initPdf() {
    var lib = window.pdfjsLib;
    if (!lib) { showMessage('Unable to load the document viewer', '<a href="' + cfg.src + '" target="_blank" rel="noopener">Open the document</a>'); return; }
    lib.GlobalWorkerOptions.workerSrc = 'player/pdfjs/pdf.worker.min.js';

    showMessage('Loading document…', null, true);

    var pdf = null, pageNum = 1, total = 0, viewed = null;
    var zoom = 1, renderTask = null, pendingPage = null;
    var restored = parseSuspend(saved.suspendData);

    var toolbar = el('div', { 'class': 'toolbar', role: 'toolbar', 'aria-label': 'Document controls' });
    var prevBtn = el('button', { 'class': 'btn', type: 'button', title: 'Previous page (←)', 'aria-label': 'Previous page' }, '&#8249; Prev');
    var nextBtn = el('button', { 'class': 'btn primary', type: 'button', title: 'Next page (→)', 'aria-label': 'Next page' }, 'Next &#8250;');
    var pageInfo = el('div', { 'class': 'pageinfo' });
    var pageInput = el('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Page number' });
    var pageCount = el('span');
    pageInfo.appendChild(pageInput); pageInfo.appendChild(pageCount);
    var zoomOut = el('button', { 'class': 'btn zoom', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out' }, '&minus;');
    var zoomFit = el('button', { 'class': 'btn zoom', type: 'button', title: 'Fit to window', 'aria-label': 'Fit to window' }, 'Fit');
    var zoomIn = el('button', { 'class': 'btn zoom', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in' }, '+');
    var fsBtn = el('button', { 'class': 'btn', type: 'button', title: 'Full screen', 'aria-label': 'Full screen' }, '&#x26F6;');

    toolbar.appendChild(prevBtn); toolbar.appendChild(pageInfo); toolbar.appendChild(nextBtn);
    toolbar.appendChild(el('span', { 'class': 'sep' }));
    toolbar.appendChild(zoomOut); toolbar.appendChild(zoomFit); toolbar.appendChild(zoomIn);
    var fsTarget = document.documentElement;
    var canFs = fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen;
    if (canFs) toolbar.appendChild(fsBtn);

    var viewport = el('div', { 'class': 'viewport', tabindex: '0' });
    var canvas = el('canvas', { 'class': 'page-canvas', role: 'img' });
    viewport.appendChild(canvas);

    function saveState() {
      updateProgress(viewed.count() / total, String(pageNum), 'v1|' + viewed.toHex() + '|');
    }

    var busy = false;
    function afterRender() {
      busy = false;
      renderTask = null;
      if (pendingPage !== null) { var p = pendingPage; pendingPage = null; render(p); }
    }

    function render(num) {
      if (busy) { pendingPage = num; if (renderTask) renderTask.cancel(); return; }
      busy = true;
      pdf.getPage(num).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var availW = Math.max(100, viewport.clientWidth - 32);
        var availH = Math.max(100, viewport.clientHeight - 32);
        // Landscape pages (slides) fit whole; portrait pages fit width.
        var landscape = base.width > base.height;
        var fit = landscape ? Math.min(availW / base.width, availH / base.height) : availW / base.width;
        viewport.className = 'viewport' + (landscape && zoom <= 1 ? ' fit-page' : '');
        var cssScale = fit * zoom;
        var dpr = window.devicePixelRatio || 1;
        var vp = page.getViewport({ scale: cssScale * dpr });
        // Keep under mobile Safari's canvas limit (~16.7 MP).
        var maxPx = 16000000;
        var shrink = Math.min(1, Math.sqrt(maxPx / (vp.width * vp.height)));
        if (shrink < 1) vp = page.getViewport({ scale: cssScale * dpr * shrink });

        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = Math.floor(base.width * cssScale) + 'px';
        canvas.style.height = Math.floor(base.height * cssScale) + 'px';
        canvas.setAttribute('aria-label', 'Page ' + num + ' of ' + total);

        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
        return renderTask.promise.then(function () {
          // Only count the page if the learner is still on it.
          if (pendingPage === null && num === pageNum) {
            viewed.set(num - 1);
            saveState();
          }
          afterRender();
        }, afterRender);
      }).then(null, afterRender);
    }

    function go(num) {
      num = Math.max(1, Math.min(total, num | 0));
      pageNum = num;
      pageInput.value = String(num);
      prevBtn.disabled = num <= 1;
      nextBtn.disabled = num >= total;
      viewport.scrollTop = 0;
      render(num);
    }

    prevBtn.onclick = function () { go(pageNum - 1); };
    nextBtn.onclick = function () { go(pageNum + 1); };
    pageInput.onchange = function () { go(parseInt(pageInput.value, 10) || pageNum); };
    pageInput.onkeydown = function (e) { if (e.keyCode === 13) pageInput.onchange(); };
    zoomIn.onclick = function () { zoom = Math.min(4, zoom * 1.25); render(pageNum); };
    zoomOut.onclick = function () { zoom = Math.max(0.5, zoom / 1.25); render(pageNum); };
    zoomFit.onclick = function () { zoom = 1; render(pageNum); };
    fsBtn.onclick = function () {
      var d = document;
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
    };

    document.addEventListener('keydown', function (e) {
      if (e.target === pageInput) return;
      if (e.keyCode === 37 || e.keyCode === 33) { go(pageNum - 1); e.preventDefault(); }
      else if (e.keyCode === 39 || e.keyCode === 34) { go(pageNum + 1); e.preventDefault(); }
      else if (e.keyCode === 36) { go(1); e.preventDefault(); }
      else if (e.keyCode === 35) { go(total); e.preventDefault(); }
    });

    // Swipe between pages on touch devices when not zoomed in.
    var touchX = null, touchY = null;
    viewport.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } else touchX = null;
    }, { passive: true });
    viewport.addEventListener('touchend', function (e) {
      if (touchX === null || zoom > 1) return;
      var dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(pageNum + (dx < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (pdf) render(pageNum); }, 150);
    });

    lib.getDocument({
      url: cfg.src,
      cMapUrl: 'player/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'player/pdfjs/standard_fonts/',
      isEvalSupported: false,
    }).promise.then(function (doc) {
      pdf = doc;
      total = doc.numPages;
      viewed = new Bits(total);
      viewed.fromHex(restored.bits);
      pageCount.textContent = '/ ' + total;
      stage.innerHTML = '';
      stage.appendChild(toolbar);
      stage.appendChild(viewport);
      var start = parseInt(saved.location, 10);
      if (start > 1 && start <= total) {
        go(start);
        toast('Resumed at page ' + start);
      } else go(1);
      viewport.focus();
    }, function (err) {
      showMessage('This document could not be displayed',
        (err && err.name === 'PasswordException' ? 'The PDF is password protected.' : 'Your browser could not open the document.') +
        ' <br><a href="' + cfg.src + '" target="_blank" rel="noopener">Open the document directly</a>');
    });
  }

  // -------------------------------------------------------------------
  // Video player
  // -------------------------------------------------------------------
  function initVideo() {
    var wrap = el('div', { 'class': 'video-wrap' });
    var video = el('video', { controls: '', playsinline: '', 'webkit-playsinline': '', preload: 'metadata', controlsList: 'nodownload' });
    video.setAttribute('aria-label', cfg.title);
    if (cfg.poster) video.setAttribute('poster', cfg.poster);
    video.src = cfg.src;
    wrap.appendChild(video);
    stage.innerHTML = '';
    stage.appendChild(wrap);

    var restored = parseSuspend(saved.suspendData);
    var buckets = null, bucketSize = 1, lastTime = 0, maxWatched = parseFloat(restored.extra) || 0;
    var lastSave = 0, seekingGuard = false;

    function watchedRatio() { return buckets ? buckets.count() / buckets.n : 0; }

    function mark(from, to) {
      if (!buckets) return;
      var a = Math.floor(from / bucketSize), b = Math.floor(to / bucketSize);
      for (var i = a; i <= b; i++) buckets.set(i);
    }

    function save(force) {
      if (!buckets) return;
      var now = new Date().getTime();
      var reachedThreshold = !isComplete && watchedRatio() + 1e-9 >= threshold;
      if (!force && !reachedThreshold && now - lastSave < 5000) { renderProgress(watchedRatio()); return; }
      lastSave = now;
      updateProgress(watchedRatio(), String(Math.floor(video.currentTime)), 'v1|' + buckets.toHex() + '|' + Math.floor(maxWatched));
    }

    video.addEventListener('loadedmetadata', function () {
      var d = video.duration;
      if (!d || !isFinite(d)) return;
      // At most ~8000 buckets keeps suspend_data under 2000 characters.
      bucketSize = Math.max(1, Math.ceil(d / 8000));
      buckets = new Bits(Math.max(1, Math.ceil(d / bucketSize)));
      buckets.fromHex(restored.bits);
      var resumeAt = parseFloat(saved.location);
      if (resumeAt > 5 && resumeAt < d - 5) {
        video.currentTime = resumeAt;
        lastTime = resumeAt;
        toast('Resumed at ' + fmtTime(resumeAt));
      }
      renderProgress(watchedRatio());
    });

    video.addEventListener('timeupdate', function () {
      var t = video.currentTime;
      if (seekingGuard) return;
      // Only count continuous playback (not jumps from seeking).
      if (!video.seeking && t >= lastTime && t - lastTime < 3 * Math.max(1, video.playbackRate || 1)) {
        mark(lastTime, t);
        if (t > maxWatched) maxWatched = t;
      }
      lastTime = t;
      save(false);
    });

    video.addEventListener('seeking', function () {
      if (cfg.restrictSeek && !isComplete && video.currentTime > maxWatched + 2) {
        seekingGuard = true;
        video.currentTime = maxWatched;
        toast('Skipping ahead is disabled until you have watched the video.');
        setTimeout(function () { seekingGuard = false; }, 300);
      }
      lastTime = video.currentTime;
    });

    video.addEventListener('pause', function () { save(true); scorm.commit(); });
    video.addEventListener('ended', function () {
      if (buckets) { mark(lastTime, video.duration); buckets.set(buckets.n - 1); }
      maxWatched = video.duration;
      save(true);
    });

    video.addEventListener('error', function () {
      showMessage('This video could not be played', 'Your browser was unable to play the video. <a href="' + cfg.src + '" target="_blank" rel="noopener">Try opening it directly</a>.');
    });

    renderProgress(0);
  }

  renderProgress(0);
  if (cfg.type === 'pdf') initPdf(); else initVideo();
})(window, document);
