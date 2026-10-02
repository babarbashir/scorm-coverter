/*
 * Shared utilities and the PDF / video viewers.
 * Each viewer is Viewers[kind](container, ctx) -> { destroy() }.
 * ES5 on purpose; see scorm-api.js.
 */
(function (window, document) {
  'use strict';

  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var U = {
    el: function (tag, attrs, html) {
      var e = document.createElement(tag);
      if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
      if (html != null) e.innerHTML = html;
      return e;
    },
    text: function (tag, attrs, text) {
      var e = U.el(tag, attrs);
      e.textContent = text;
      return e;
    },
    toast: function (msg) {
      toastEl.textContent = msg;
      toastEl.className = 'show';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.className = ''; }, 3200);
    },
    message: function (container, title, body, spinner) {
      container.innerHTML = '';
      var m = U.el('div', { 'class': 'message' });
      if (spinner) m.appendChild(U.el('div', { 'class': 'spinner' }));
      m.appendChild(U.text('h2', null, title));
      if (body) m.appendChild(U.el('p', null, body));
      container.appendChild(m);
    },
    fmtTime: function (sec) {
      sec = Math.max(0, Math.floor(sec));
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },
    Bits: Bits,
  };

  // Compact bitset serialised as hex.
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

  window.PlayerUtil = U;
  var Viewers = window.Viewers = {};

  // Bitmap budget shared by all file items so suspend_data stays under 4000.
  function bitBudget(cfg) {
    var files = 0;
    for (var i = 0; i < cfg.items.length; i++) if (cfg.items[i].kind !== 'quiz') files++;
    return Math.max(64, Math.floor(12000 / Math.max(1, files)));
  }

  // -------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------
  Viewers.pdf = function (stage, ctx) {
    var item = ctx.item, state = ctx.state;
    var lib = window.pdfjsLib;
    var destroyed = false;
    var listeners = [];
    function on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts || false); listeners.push([target, ev, fn, opts || false]); }

    if (!lib) { U.message(stage, 'Unable to load the document viewer', '<a href="' + item.src + '" target="_blank" rel="noopener">Open the document</a>'); return {}; }
    lib.GlobalWorkerOptions.workerSrc = 'player/pdfjs/pdf.worker.min.js';
    U.message(stage, 'Loading document…', null, true);

    var pdf = null, loadingTask = null, pageNum = 1, total = 0, viewed = null;
    var zoom = 1, renderTask = null, pendingPage = null, busy = false;

    var wrap = U.el('div', { 'class': 'pdf-view' });
    var toolbar = U.el('div', { 'class': 'toolbar', role: 'toolbar', 'aria-label': 'Document controls' });
    var prevBtn = U.el('button', { 'class': 'btn', type: 'button', title: 'Previous page (←)', 'aria-label': 'Previous page' }, '&#8249; Prev');
    var nextBtn = U.el('button', { 'class': 'btn primary', type: 'button', title: 'Next page (→)', 'aria-label': 'Next page' }, 'Next &#8250;');
    var pageInfo = U.el('div', { 'class': 'pageinfo' });
    var pageInput = U.el('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Page number' });
    var pageCount = U.el('span');
    pageInfo.appendChild(pageInput); pageInfo.appendChild(pageCount);
    var zoomOut = U.el('button', { 'class': 'btn zoom', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out' }, '&minus;');
    var zoomFit = U.el('button', { 'class': 'btn zoom', type: 'button', title: 'Fit to window', 'aria-label': 'Fit to window' }, 'Fit');
    var zoomIn = U.el('button', { 'class': 'btn zoom', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in' }, '+');
    var fsBtn = U.el('button', { 'class': 'btn', type: 'button', title: 'Full screen', 'aria-label': 'Full screen' }, '&#x26F6;');
    toolbar.appendChild(prevBtn); toolbar.appendChild(pageInfo); toolbar.appendChild(nextBtn);
    toolbar.appendChild(U.el('span', { 'class': 'sep' }));
    toolbar.appendChild(zoomOut); toolbar.appendChild(zoomFit); toolbar.appendChild(zoomIn);
    var fsTarget = document.documentElement;
    if (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen) toolbar.appendChild(fsBtn);

    var viewport = U.el('div', { 'class': 'viewport', tabindex: '0' });
    var canvas = U.el('canvas', { 'class': 'page-canvas', role: 'img' });
    viewport.appendChild(canvas);
    wrap.appendChild(toolbar);
    wrap.appendChild(viewport);

    // On the last page "Next" becomes "Continue" once the next section is open.
    function updateNext() {
      var atEnd = pageNum >= total;
      nextBtn.disabled = atEnd && !ctx.hasNext();
      nextBtn.innerHTML = atEnd && ctx.hasNext() ? ctx.nextLabel() + ' &#8250;' : 'Next &#8250;';
    }

    function save() {
      ctx.update({ ratio: viewed.count() / total, pos: pageNum, bits: viewed.toHex() });
      updateNext();
    }

    function afterRender() {
      busy = false;
      renderTask = null;
      if (pendingPage !== null && !destroyed) { var p = pendingPage; pendingPage = null; render(p); }
    }

    function render(num) {
      if (destroyed) return;
      if (busy) { pendingPage = num; if (renderTask) renderTask.cancel(); return; }
      busy = true;
      pdf.getPage(num).then(function (page) {
        if (destroyed) return afterRender();
        var base = page.getViewport({ scale: 1 });
        var availW = Math.max(100, viewport.clientWidth - 32);
        var availH = Math.max(100, viewport.clientHeight - 32);
        var landscape = base.width > base.height;
        var fit = landscape ? Math.min(availW / base.width, availH / base.height) : availW / base.width;
        viewport.className = 'viewport' + (landscape && zoom <= 1 ? ' fit-page' : '');
        var cssScale = fit * zoom;
        var dpr = window.devicePixelRatio || 1;
        var vp = page.getViewport({ scale: cssScale * dpr });
        var shrink = Math.min(1, Math.sqrt(16000000 / (vp.width * vp.height)));
        if (shrink < 1) vp = page.getViewport({ scale: cssScale * dpr * shrink });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = Math.floor(base.width * cssScale) + 'px';
        canvas.style.height = Math.floor(base.height * cssScale) + 'px';
        canvas.setAttribute('aria-label', 'Page ' + num + ' of ' + total);
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
        return renderTask.promise.then(function () {
          if (pendingPage === null && num === pageNum && !destroyed) { viewed.set(num - 1); save(); }
          afterRender();
        }, afterRender);
      }).then(null, afterRender);
    }

    function go(num) {
      num = Math.max(1, Math.min(total, num | 0));
      pageNum = num;
      pageInput.value = String(num);
      prevBtn.disabled = num <= 1;
      updateNext();
      viewport.scrollTop = 0;
      render(num);
    }

    prevBtn.onclick = function () { go(pageNum - 1); };
    nextBtn.onclick = function () { if (pageNum >= total) ctx.next(); else go(pageNum + 1); };
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

    on(document, 'keydown', function (e) {
      if (!pdf || e.target === pageInput || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.keyCode === 37 || e.keyCode === 33) { go(pageNum - 1); e.preventDefault(); }
      else if (e.keyCode === 39 || e.keyCode === 34) { go(pageNum + 1); e.preventDefault(); }
      else if (e.keyCode === 36) { go(1); e.preventDefault(); }
      else if (e.keyCode === 35) { go(total); e.preventDefault(); }
    });

    var touchX = null, touchY = null;
    on(viewport, 'touchstart', function (e) {
      if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } else touchX = null;
    }, { passive: true });
    on(viewport, 'touchend', function (e) {
      if (touchX === null || zoom > 1) return;
      var dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(pageNum + (dx < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });

    var resizeTimer = null;
    on(window, 'resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (pdf) render(pageNum); }, 150);
    });

    loadingTask = lib.getDocument({
      url: item.src,
      cMapUrl: 'player/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'player/pdfjs/standard_fonts/',
      isEvalSupported: false,
    });
    loadingTask.promise.then(function (doc) {
      if (destroyed) return;
      pdf = doc;
      total = doc.numPages;
      viewed = new Bits(total);
      if (!state.done) viewed.fromHex(state.bits);
      else for (var i = 0; i < total; i++) viewed.set(i);
      pageCount.textContent = '/ ' + total;
      stage.innerHTML = '';
      stage.appendChild(wrap);
      var start = parseInt(state.pos, 10);
      if (start > 1 && start <= total) { go(start); U.toast('Resumed at page ' + start); } else go(1);
      viewport.focus();
    }, function (err) {
      if (destroyed) return;
      U.message(stage, 'This document could not be displayed',
        (err && err.name === 'PasswordException' ? 'The PDF is password protected.' : 'Your browser could not open the document.') +
        ' <br><a href="' + item.src + '" target="_blank" rel="noopener">Open the document directly</a>');
    });

    return {
      destroy: function () {
        destroyed = true;
        for (var i = 0; i < listeners.length; i++) listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
        if (renderTask) try { renderTask.cancel(); } catch (e) {}
        if (pdf) try { pdf.destroy(); } catch (e2) {}
        else if (loadingTask) try { loadingTask.destroy(); } catch (e3) {}
      },
    };
  };

  // -------------------------------------------------------------------
  // Video
  // -------------------------------------------------------------------
  Viewers.video = function (stage, ctx) {
    var item = ctx.item, state = ctx.state, cfg = ctx.config;
    var wrap = U.el('div', { 'class': 'video-wrap' });
    var video = U.el('video', { controls: '', playsinline: '', 'webkit-playsinline': '', preload: 'metadata', controlsList: 'nodownload' });
    video.setAttribute('aria-label', item.title);
    if (item.poster) video.setAttribute('poster', item.poster);
    video.src = item.src;
    wrap.appendChild(video);

    var endBar = U.el('div', { 'class': 'video-next', hidden: '' });
    var nextBtn = U.el('button', { 'class': 'btn primary', type: 'button' }, ctx.nextLabel() + ' &#8250;');
    nextBtn.onclick = function () { ctx.next(); };
    endBar.appendChild(nextBtn);
    wrap.appendChild(endBar);
    stage.appendChild(wrap);

    var buckets = null, bucketSize = 1, lastTime = 0;
    var maxWatched = parseFloat(state.extra) || 0;
    var lastSave = 0, seekingGuard = false;

    function ratio() { return buckets ? buckets.count() / buckets.n : 0; }

    function mark(from, to) {
      if (!buckets) return;
      var a = Math.floor(from / bucketSize), b = Math.floor(to / bucketSize);
      for (var i = a; i <= b; i++) buckets.set(i);
    }

    function save(force) {
      if (!buckets) return;
      var now = new Date().getTime();
      var reached = !state.done && ratio() + 1e-9 >= item.threshold / 100;
      if (!force && !reached && now - lastSave < 5000) return;
      lastSave = now;
      ctx.update({ ratio: ratio(), pos: Math.floor(video.currentTime), bits: buckets.toHex(), extra: Math.floor(maxWatched) });
      if (state.done && ctx.hasNext()) endBar.hidden = false;
    }

    video.addEventListener('loadedmetadata', function () {
      var d = video.duration;
      if (!d || !isFinite(d)) return;
      var maxBuckets = bitBudget(cfg);
      bucketSize = Math.max(1, Math.ceil(d / maxBuckets));
      buckets = new Bits(Math.max(1, Math.ceil(d / bucketSize)));
      if (state.done) { for (var i = 0; i < buckets.n; i++) buckets.set(i); maxWatched = d; }
      else buckets.fromHex(state.bits);
      if (state.done && ctx.hasNext()) endBar.hidden = false;
      var resumeAt = parseFloat(state.pos);
      if (resumeAt > 5 && resumeAt < d - 5) {
        video.currentTime = resumeAt;
        lastTime = resumeAt;
        U.toast('Resumed at ' + U.fmtTime(resumeAt));
      }
    });

    video.addEventListener('timeupdate', function () {
      var t = video.currentTime;
      if (seekingGuard) return;
      if (!video.seeking && t >= lastTime && t - lastTime < 3 * Math.max(1, video.playbackRate || 1)) {
        mark(lastTime, t);
        if (t > maxWatched) maxWatched = t;
      }
      lastTime = t;
      save(false);
    });

    video.addEventListener('seeking', function () {
      if (item.restrictSeek && !state.done && video.currentTime > maxWatched + 2) {
        seekingGuard = true;
        video.currentTime = maxWatched;
        U.toast('Skipping ahead is disabled until you have watched the video.');
        setTimeout(function () { seekingGuard = false; }, 300);
      }
      lastTime = video.currentTime;
    });

    video.addEventListener('pause', function () { save(true); });
    video.addEventListener('ended', function () {
      if (buckets) { mark(lastTime, video.duration); buckets.set(buckets.n - 1); }
      maxWatched = video.duration;
      save(true);
    });
    video.addEventListener('error', function () {
      U.message(stage, 'This video could not be played', 'Your browser was unable to play the video. <a href="' + item.src + '" target="_blank" rel="noopener">Try opening it directly</a>.');
    });

    return {
      destroy: function () {
        try { if (!video.paused) { video.pause(); } save(true); } catch (e) {}
        video.removeAttribute('src');
        try { video.load(); } catch (e2) {}
      },
    };
  };
})(window, document);
