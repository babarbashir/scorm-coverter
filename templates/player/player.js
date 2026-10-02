/*
 * Course shell: menu, navigation rules, shared completion and scoring.
 * Viewers (viewers.js, quiz.js) render one item at a time and report
 * progress back through the ctx object they are given.
 * ES5 on purpose; see scorm-api.js.
 */
(function (window, document) {
  'use strict';

  var cfg = window.SCORM_CONFIG;
  var scorm = window.ScormRuntime;
  var U = window.PlayerUtil;
  var items = cfg.items;
  var single = items.length === 1;

  var saved = scorm.start();
  var current = -1;
  var viewer = null;
  var lastOutcome = '';

  // -------------------------------------------------------------------
  // Saved state
  //   suspend_data: "v2|" + one entry per item, ";"-separated
  //     file: done,hexbits,extra      quiz: done,attempts,bestPct,passed
  //   location: "<itemIndex>:<position>"
  // Finished file items drop their bitmaps to keep under the 4000 char cap.
  // -------------------------------------------------------------------
  var states = [];
  (function restore() {
    var parts = String(saved.suspendData || '').split('|');
    var entries = parts[0] === 'v2' ? (parts[1] || '').split(';') : [];
    for (var i = 0; i < items.length; i++) {
      var f = (entries[i] || '').split(',');
      if (items[i].kind === 'quiz') {
        states.push({ done: f[0] === '1', attempts: parseInt(f[1], 10) || 0, best: parseFloat(f[2]) || 0, passed: f[3] === '1', ratio: 0, pos: '' });
      } else {
        states.push({ done: f[0] === '1', bits: f[1] || '', extra: f[2] || '', ratio: f[0] === '1' ? 1 : 0, pos: '' });
      }
    }
  })();

  function serialize() {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var s = states[i];
      if (items[i].kind === 'quiz') out.push([s.done ? 1 : 0, s.attempts, Math.round(s.best * 100) / 100, s.passed ? 1 : 0].join(','));
      else out.push(s.done ? '1' : ['0', s.bits, s.extra].join(','));
    }
    return 'v2|' + out.join(';');
  }

  var savedLoc = String(saved.location || '').split(':');
  var resumeIndex = parseInt(savedLoc[0], 10);
  if (!(resumeIndex >= 0 && resumeIndex < items.length)) resumeIndex = -1;
  if (resumeIndex >= 0) states[resumeIndex].pos = savedLoc.slice(1).join(':');

  // -------------------------------------------------------------------
  // Outcome
  // -------------------------------------------------------------------
  function requiredQuizzes() {
    var q = [];
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'quiz' && items[i].required) q.push(i);
    return q;
  }

  function outcome() {
    var contentDone = true;
    for (var i = 0; i < items.length; i++) if (items[i].required && !states[i].done) contentDone = false;

    var quizzes = requiredQuizzes();
    var success = 'unknown';
    var score = null;
    if (quizzes.length) {
      var allPassed = true, anyFailedFinal = false, attempted = false, got = 0, max = 0;
      for (var k = 0; k < quizzes.length; k++) {
        var s = states[quizzes[k]], qz = items[quizzes[k]].quiz;
        var weight = qz.drawCount || qz.questions.length;
        if (!s.passed) allPassed = false;
        if (!s.passed && s.done) anyFailedFinal = true;
        if (s.attempts) attempted = true;
        got += (s.best / 100) * weight;
        max += weight;
      }
      if (allPassed) success = 'passed';
      else if (anyFailedFinal) success = 'failed';
      if (attempted) score = max ? (got / max) * 100 : 0;
    } else if (contentDone) {
      if (cfg.passOnComplete) success = 'passed';
      if (cfg.reportScore) score = 100;
    }
    return { completed: contentDone, success: success, score: score };
  }

  function overallRatio() {
    var req = 0, sum = 0;
    for (var i = 0; i < items.length; i++) {
      if (!items[i].required) continue;
      req++;
      sum += states[i].done ? 1 : Math.min(0.99, states[i].ratio || 0);
    }
    return req ? sum / req : 1;
  }

  // -------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------
  var app = document.getElementById('app');
  var menu = document.getElementById('menu');
  var menuList = document.getElementById('menu-list');
  var stage = document.getElementById('stage');
  var itemTitle = document.getElementById('item-title');
  var prevItemBtn = document.getElementById('prev-item');
  var nextItemBtn = document.getElementById('next-item');
  var menuToggle = document.getElementById('menu-toggle');
  var meterFill = document.getElementById('meter-fill');
  var meter = meterFill.parentNode;
  var statusText = document.getElementById('status-text');

  if (single) app.className += ' single';

  function isLocked(i) {
    if (cfg.navigation !== 'sequential') return false;
    for (var j = 0; j < i; j++) if (items[j].required && !states[j].done) return true;
    return false;
  }

  var ICONS = {
    pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5L13 3.5ZM8 13v2h8v-2H8Zm0 4v2h5v-2H8Z"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h11a2 2 0 0 1 2 2v2.5l4-3v11l-4-3V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
    quiz: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 14v2h2v-2h-2Zm1-10a4 4 0 0 0-4 4h2a2 2 0 1 1 3 1.7c-1.2.7-2 1.6-2 3.3h2c0-1 .4-1.4 1.1-1.9A4 4 0 0 0 12 6Z"/></svg>',
  };

  function statusLabel(i) {
    var s = states[i], it = items[i];
    if (isLocked(i)) return { cls: 'locked', text: 'Locked' };
    if (it.kind === 'quiz') {
      if (s.passed) return { cls: 'done', text: 'Passed · ' + Math.round(s.best) + '%' };
      if (s.done) return { cls: 'failed', text: 'Not passed · ' + Math.round(s.best) + '%' };
      if (s.attempts) return { cls: 'progress', text: 'Best ' + Math.round(s.best) + '%' };
      return { cls: 'todo', text: it.quiz.questions.length > 0 ? (it.quiz.drawCount || it.quiz.questions.length) + ' questions' : '' };
    }
    if (s.done) return { cls: 'done', text: 'Completed' };
    if (s.ratio > 0) return { cls: 'progress', text: Math.round(s.ratio * 100) + '%' };
    return { cls: 'todo', text: 'Not started' };
  }

  function renderMenu() {
    menuList.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i], st = statusLabel(i);
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item st-' + st.cls + (i === current ? ' active' : '') + (it.parent ? ' child' : '');
      b.disabled = st.cls === 'locked';
      if (i === current) b.setAttribute('aria-current', 'page');
      b.innerHTML = '<span class="mi-icon ' + it.kind + '">' + ICONS[it.kind] + '</span>' +
        '<span class="mi-text"><span class="mi-title"></span><span class="mi-status"></span></span>' +
        '<span class="mi-check" aria-hidden="true"></span>';
      b.querySelector('.mi-title').textContent = (i + 1) + '. ' + it.title + (it.required ? '' : ' (optional)');
      b.querySelector('.mi-status').textContent = st.text;
      b.setAttribute('aria-label', (i + 1) + '. ' + it.title + ', ' + st.text);
      b.onclick = (function (idx) { return function () { open(idx); closeMenuOnMobile(); }; })(i);
      li.appendChild(b);
      menuList.appendChild(li);
    }
    prevItemBtn.disabled = current <= 0;
    nextItemBtn.disabled = current >= items.length - 1 || isLocked(current + 1);
    nextItemBtn.title = isLocked(current + 1) ? 'Complete this section to continue' : '';
  }

  function renderProgress() {
    var o = outcome();
    var pct = o.completed ? 100 : Math.round(overallRatio() * 100);
    meterFill.style.width = pct + '%';
    meter.setAttribute('aria-valuenow', String(pct));
    var text;
    if (o.success === 'passed' && o.completed) text = 'Passed';
    else if (o.success === 'failed') text = 'Not passed';
    else if (o.completed) text = 'Completed';
    else text = pct + '% complete';
    statusText.textContent = text;
    app.className = app.className.replace(/\s?is-(complete|failed)/g, '') +
      (o.success === 'failed' ? ' is-failed' : (o.completed ? ' is-complete' : ''));
  }

  function persist(force) {
    var loc = current >= 0 ? current + ':' + (states[current].pos || '') : '';
    scorm.save(loc, serialize(), overallRatio());
    var o = outcome();
    var key = o.completed + '|' + o.success + '|' + (o.score == null ? '' : Math.round(o.score * 100));
    if (key !== lastOutcome) {
      var was = lastOutcome;
      lastOutcome = key;
      scorm.report(o);
      if (was && o.completed && was.indexOf('true|') !== 0) {
        U.toast(o.success === 'failed' ? 'Course finished. Your result has been recorded.' : 'Course complete. Your progress has been recorded.');
      }
    }
    if (force) scorm.commit();
    renderProgress();
  }

  // -------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------
  function makeCtx(i) {
    var it = items[i], s = states[i];
    return {
      item: it,
      state: s,
      config: cfg,
      // File viewers: ratio 0..1, pos (resume position), bits (hex), extra
      update: function (u) {
        if (u.pos != null) s.pos = String(u.pos);
        if (u.bits != null) s.bits = u.bits;
        if (u.extra != null) s.extra = String(u.extra);
        if (u.ratio != null) s.ratio = Math.max(s.ratio || 0, u.ratio);
        var justDone = false;
        if (!s.done && it.kind !== 'quiz' && s.ratio + 1e-9 >= it.threshold / 100) { s.done = true; justDone = true; }
        persist(false);
        if (justDone) sectionDone(i);
        else renderMenu();
      },
      // Quiz: called after each submitted attempt.
      quizResult: function (pct, passed) {
        s.attempts++;
        s.best = Math.max(s.best, pct);
        if (passed) s.passed = true;
        var max = it.quiz.maxAttempts;
        var wasDone = s.done;
        s.done = s.passed || (max > 0 && s.attempts >= max);
        s.ratio = s.done ? 1 : s.ratio;
        persist(true);
        renderMenu();
        if (s.done && !wasDone && s.passed) sectionDone(i, true);
      },
      next: function () { if (i < items.length - 1 && !isLocked(i + 1)) open(i + 1); },
      hasNext: function () { return i < items.length - 1 && !isLocked(i + 1); },
      // Label for the "go on" button: points at this section's own quiz if it has one.
      nextLabel: function () {
        var n = items[i + 1];
        return n && n.parent === it.id ? 'Take the quiz' : 'Continue';
      },
    };
  }

  function sectionDone(i, quiet) {
    renderMenu();
    if (single || quiet) return;
    var nextIdx = i + 1;
    if (nextIdx < items.length) U.toast('Section complete. You can continue to "' + items[nextIdx].title + '".');
  }

  function open(i) {
    if (i < 0 || i >= items.length || isLocked(i)) return;
    if (viewer && viewer.destroy) viewer.destroy();
    viewer = null;
    current = i;
    itemTitle.textContent = single ? '' : items[i].title;
    stage.innerHTML = '';
    stage.scrollTop = 0;
    var Viewer = window.Viewers[items[i].kind];
    viewer = Viewer(stage, makeCtx(i));
    renderMenu();
    persist(false);
  }

  prevItemBtn.onclick = function () { open(current - 1); };
  nextItemBtn.onclick = function () { open(current + 1); };

  function closeMenuOnMobile() {
    if (window.innerWidth < 760) app.className = app.className.replace(/\s?menu-open/g, '');
  }
  menuToggle.onclick = function () {
    if (/menu-open/.test(app.className)) app.className = app.className.replace(/\s?menu-open/g, '');
    else app.className += ' menu-open';
    menuToggle.setAttribute('aria-expanded', /menu-open/.test(app.className) ? 'true' : 'false');
  };
  if (window.innerWidth >= 760 && !single) { app.className += ' menu-open'; menuToggle.setAttribute('aria-expanded', 'true'); }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  // The first persist() reports the restored outcome; report() only writes
  // values that differ from what the LMS already holds.
  if (!scorm.connected) {
    setTimeout(function () { U.toast('Preview mode: no LMS connection, progress will not be saved.'); }, 600);
  }

  var first = resumeIndex;
  if (first < 0 || isLocked(first)) {
    first = 0;
    for (var k = 0; k < items.length; k++) { if (!states[k].done && !isLocked(k)) { first = k; break; } }
  }
  open(first);
  if (resumeIndex > 0 && first === resumeIndex) U.toast('Welcome back. Picking up at "' + items[first].title + '".');
})(window, document);
