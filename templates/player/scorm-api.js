/*
 * SCORM runtime wrapper (SCORM 1.2 and SCORM 2004).
 *
 * Written in ES5 so it runs in the older embedded browsers some LMS mobile
 * apps still use. Exposes window.ScormRuntime.
 *
 * Compatibility notes:
 *  - The API object is searched up the frame chain, then through
 *    window.opener (popup launches), tolerating cross-origin frames.
 *  - Initialize/Terminate are each called exactly once.
 *  - Status is never downgraded (completed/passed stays completed/passed).
 *  - Commits are throttled; many LMSs struggle with a commit per second.
 *  - Values respect the size limits of each version (suspend_data 4096
 *    characters in 1.2, lesson_location 255).
 *  - Terminate runs on pagehide/beforeunload/unload so data is saved however
 *    the learner leaves.
 */
(function (window) {
  'use strict';

  var cfg = window.SCORM_CONFIG || {};
  var preferred = cfg.version === '1.2' ? '1.2' : '2004';

  var api = null;
  var version = null;
  var initialized = false;
  var terminated = false;
  var dirty = false;
  var completed = false;
  var reviewMode = false;
  var startTime = new Date().getTime();
  var commitTimer = null;
  var log = [];
  // Mirror of what the LMS currently holds, so report() can avoid downgrades.
  var status12 = '';
  var completion2004 = '';
  var success2004 = '';
  var lastScore = null;
  var interactionIndex = -1;

  function debug(msg) {
    log.push(msg);
    if (log.length > 200) log.shift();
    if (window.console && window.SCORM_DEBUG) window.console.log('[SCORM] ' + msg);
  }

  // ---------------------------------------------------------------------
  // API discovery
  // ---------------------------------------------------------------------
  function scanChain(win, prop) {
    for (var i = 0; win && i < 25; i++) {
      try { if (win[prop]) return win[prop]; } catch (e) { /* cross-origin frame */ }
      var parent = null;
      try { parent = win.parent; } catch (e2) { parent = null; }
      if (!parent || parent === win) break;
      win = parent;
    }
    return null;
  }

  function locate(prop) {
    var found = scanChain(window, prop);
    if (!found) { try { if (window.opener) found = scanChain(window.opener, prop); } catch (e) {} }
    if (!found) { try { if (window.top && window.top.opener) found = scanChain(window.top.opener, prop); } catch (e2) {} }
    return found;
  }

  function discover() {
    var order = preferred === '1.2' ? [['API', '1.2'], ['API_1484_11', '2004']] : [['API_1484_11', '2004'], ['API', '1.2']];
    for (var i = 0; i < order.length; i++) {
      var a = locate(order[i][0]);
      if (a) { api = a; version = order[i][1]; return true; }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Low level calls
  // ---------------------------------------------------------------------
  function ok(r) { return r === true || r === 'true'; }

  function lastError() {
    try {
      var code = version === '1.2' ? api.LMSGetLastError() : api.GetLastError();
      if (code && String(code) !== '0') {
        var msg = version === '1.2' ? api.LMSGetErrorString(code) : api.GetErrorString(code);
        return code + ' ' + msg;
      }
    } catch (e) {}
    return '';
  }

  function getValue(key) {
    if (!initialized || terminated) return '';
    try {
      var v = version === '1.2' ? api.LMSGetValue(key) : api.GetValue(key);
      return v == null ? '' : String(v);
    } catch (e) { debug('GetValue(' + key + ') threw ' + e); return ''; }
  }

  function setValue(key, value) {
    if (!initialized || terminated) return false;
    try {
      var r = version === '1.2' ? api.LMSSetValue(key, String(value)) : api.SetValue(key, String(value));
      if (!ok(r)) debug('SetValue(' + key + ') failed: ' + lastError());
      else dirty = true;
      return ok(r);
    } catch (e) { debug('SetValue(' + key + ') threw ' + e); return false; }
  }

  function commitNow() {
    if (!initialized || terminated) return false;
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
    try {
      var r = version === '1.2' ? api.LMSCommit('') : api.Commit('');
      if (ok(r)) dirty = false; else debug('Commit failed: ' + lastError());
      return ok(r);
    } catch (e) { debug('Commit threw ' + e); return false; }
  }

  function scheduleCommit() {
    if (commitTimer || !initialized || terminated) return;
    commitTimer = setTimeout(function () { commitTimer = null; if (dirty) commitNow(); }, 10000);
  }

  // ---------------------------------------------------------------------
  // Time formats
  // ---------------------------------------------------------------------
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

  // SCORM 1.2 CMITimespan: HHHH:MM:SS.SS
  function time12(ms) {
    var cs = Math.max(0, Math.round(ms / 10));
    var h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000); cs -= m * 6000;
    var s = Math.floor(cs / 100); cs -= s * 100;
    if (h > 9999) { h = 9999; m = 59; s = 59; cs = 99; }
    // Two-digit hours are valid (HH to HHHH) and accepted by every LMS.
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(cs, 2);
  }

  // SCORM 2004 timeinterval (ISO 8601 duration), max 2 decimal places.
  function time2004(ms) {
    var cs = Math.max(0, Math.round(ms / 10));
    var h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000); cs -= m * 6000;
    var s = (cs / 100).toFixed(2).replace(/\.?0+$/, '');
    return 'PT' + h + 'H' + m + 'M' + (s || '0') + 'S';
  }

  // ---------------------------------------------------------------------
  // Public runtime
  // ---------------------------------------------------------------------
  var Runtime = {
    get connected() { return initialized && !terminated; },
    get version() { return version; },
    get completed() { return completed; },
    get reviewMode() { return reviewMode; },
    log: log,

    // Returns the saved state: { location, suspendData, completed, success }
    start: function () {
      var state = { location: '', suspendData: '', completed: false, success: 'unknown' };
      if (initialized) return state;
      if (!discover()) { debug('No LMS API found, running standalone'); return state; }

      var r;
      try { r = version === '1.2' ? api.LMSInitialize('') : api.Initialize(''); } catch (e) { r = false; debug('Initialize threw ' + e); }
      if (!ok(r)) {
        // Error 101 (1.2) / 103 (2004) means already initialized by a
        // previous page in the same attempt; treat that as success.
        var code = '';
        try { code = String(version === '1.2' ? api.LMSGetLastError() : api.GetLastError()); } catch (e2) {}
        if (code !== '101' && code !== '103') { debug('Initialize failed: ' + lastError()); api = null; return state; }
      }
      initialized = true;
      debug('Initialized SCORM ' + version);

      if (version === '1.2') {
        var status = getValue('cmi.core.lesson_status');
        status12 = status;
        reviewMode = getValue('cmi.core.lesson_mode') === 'review';
        completed = status === 'completed' || status === 'passed' || status === 'failed';
        if (!reviewMode && (status === '' || status === 'not attempted' || status === 'unknown' || status === 'browsed')) {
          setValue('cmi.core.lesson_status', 'incomplete');
          status12 = 'incomplete';
        }
        state.location = getValue('cmi.core.lesson_location');
        state.success = status === 'passed' || status === 'failed' ? status : 'unknown';
        var s12 = getValue('cmi.core.score.raw');
        if (s12 !== '' && !isNaN(s12)) lastScore = parseFloat(s12);
      } else {
        var cs = getValue('cmi.completion_status');
        completion2004 = cs;
        success2004 = getValue('cmi.success_status');
        reviewMode = getValue('cmi.mode') === 'review';
        completed = cs === 'completed';
        if (!reviewMode && cs !== 'completed' && cs !== 'incomplete') {
          setValue('cmi.completion_status', 'incomplete');
          completion2004 = 'incomplete';
        }
        state.location = getValue('cmi.location');
        state.success = success2004 === 'passed' || success2004 === 'failed' ? success2004 : 'unknown';
        var s04 = getValue('cmi.score.raw');
        if (s04 !== '' && !isNaN(s04)) lastScore = parseFloat(s04);
      }
      state.suspendData = getValue('cmi.suspend_data');
      state.completed = completed;
      if (dirty) commitNow();

      var self = this;
      var onLeave = function () { self.finish(); };
      if (window.addEventListener) {
        window.addEventListener('pagehide', onLeave);
        window.addEventListener('beforeunload', onLeave);
        window.addEventListener('unload', onLeave);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden' && dirty) commitNow();
        });
      }
      return state;
    },

    save: function (location, suspendData, progress) {
      if (!this.connected || reviewMode) return;
      if (location != null) {
        location = String(location);
        setValue(version === '1.2' ? 'cmi.core.lesson_location' : 'cmi.location', location.slice(0, version === '1.2' ? 255 : 1000));
      }
      if (suspendData != null) {
        suspendData = String(suspendData);
        // 4096 in 1.2 and 2004 3rd edition's guaranteed minimum; stay under it everywhere.
        if (suspendData.length <= 4000) setValue('cmi.suspend_data', suspendData);
      }
      if (progress != null && version === '2004' && !completed) {
        var p = Math.max(0, Math.min(1, progress));
        setValue('cmi.progress_measure', (Math.floor(p * 100) / 100).toFixed(2));
      }
      scheduleCommit();
    },

    /*
     * Reports the course outcome.
     *   completed: all required content done
     *   success:   'passed' | 'failed' | 'unknown'
     *   score:     0..100 or null
     * Never downgrades what the LMS already holds (passed stays passed,
     * completed stays completed), and commits right away when anything changed.
     */
    report: function (o) {
      if (!this.connected || reviewMode) { if (o.completed) completed = true; return; }
      var changed = false;
      var success = o.success === 'passed' || o.success === 'failed' ? o.success : 'unknown';

      if (o.score != null && !isNaN(o.score)) {
        var raw = Math.max(0, Math.min(100, Math.round(o.score * 100) / 100));
        if (raw !== lastScore) {
          var pre = version === '1.2' ? 'cmi.core.score.' : 'cmi.score.';
          setValue(pre + 'min', '0');
          setValue(pre + 'max', '100');
          setValue(pre + 'raw', String(raw));
          if (version === '2004') setValue('cmi.score.scaled', String(Math.round(raw * 100) / 10000));
          lastScore = raw;
          changed = true;
        }
      }

      if (version === '1.2') {
        var want = 'incomplete';
        if (success === 'failed') want = 'failed';
        else if (o.completed && success === 'passed') want = 'passed';
        else if (o.completed) want = 'completed';
        // Allowed moves only: never away from passed, never back to incomplete.
        var rank = { 'incomplete': 0, 'completed': 1, 'failed': 1, 'passed': 2 };
        var move = want !== status12 && rank[want] >= (rank[status12] || 0) && status12 !== 'passed' &&
          !(status12 === 'failed' && want === 'completed');
        if (move) { setValue('cmi.core.lesson_status', want); status12 = want; changed = true; }
        completed = status12 === 'completed' || status12 === 'passed' || status12 === 'failed';
      } else {
        if (o.completed && completion2004 !== 'completed') {
          setValue('cmi.progress_measure', '1');
          setValue('cmi.completion_status', 'completed');
          completion2004 = 'completed';
          changed = true;
        }
        if (success !== 'unknown' && success !== success2004 && success2004 !== 'passed') {
          setValue('cmi.success_status', success);
          success2004 = success;
          changed = true;
        }
        completed = completion2004 === 'completed';
      }
      if (changed) { commitNow(); debug('Reported ' + JSON.stringify(o)); }
    },

    /*
     * Records one answered question as a SCORM interaction.
     *   { id, description, response: ['a','c'], correct: ['a','c'], result: true|false }
     */
    recordInteraction: function (q) {
      if (!this.connected || reviewMode) return;
      if (interactionIndex < 0) {
        interactionIndex = parseInt(getValue('cmi.interactions._count'), 10) || 0;
      }
      var n = 'cmi.interactions.' + interactionIndex + '.';
      var id = String(q.id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 250);
      var now = new Date();
      if (!setValue(n + 'id', id)) return;
      setValue(n + 'type', 'choice');
      if (version === '1.2') {
        setValue(n + 'student_response', q.response.join(','));
        setValue(n + 'correct_responses.0.pattern', q.correct.join(','));
        setValue(n + 'result', q.result ? 'correct' : 'wrong');
        setValue(n + 'weighting', '1');
        setValue(n + 'time', pad(now.getHours(), 2) + ':' + pad(now.getMinutes(), 2) + ':' + pad(now.getSeconds(), 2));
      } else {
        if (q.description) setValue(n + 'description', String(q.description).slice(0, 250));
        setValue(n + 'learner_response', q.response.join('[,]'));
        setValue(n + 'correct_responses.0.pattern', q.correct.join('[,]'));
        setValue(n + 'result', q.result ? 'correct' : 'incorrect');
        setValue(n + 'weighting', '1');
        setValue(n + 'timestamp', now.getFullYear() + '-' + pad(now.getMonth() + 1, 2) + '-' + pad(now.getDate(), 2) +
          'T' + pad(now.getHours(), 2) + ':' + pad(now.getMinutes(), 2) + ':' + pad(now.getSeconds(), 2));
      }
      interactionIndex++;
      scheduleCommit();
    },

    commit: function () { if (dirty) commitNow(); },

    finish: function () {
      if (!initialized || terminated) return;
      var elapsed = new Date().getTime() - startTime;
      if (version === '1.2') {
        setValue('cmi.core.session_time', time12(elapsed));
        setValue('cmi.core.exit', completed ? '' : 'suspend');
      } else {
        setValue('cmi.session_time', time2004(elapsed));
        setValue('cmi.exit', completed ? 'normal' : 'suspend');
      }
      commitNow();
      try { if (version === '1.2') api.LMSFinish(''); else api.Terminate(''); } catch (e) { debug('Terminate threw ' + e); }
      terminated = true;
      debug('Terminated');
    },

    // Exposed for tests.
    _time12: time12,
    _time2004: time2004,
  };

  window.ScormRuntime = Runtime;
})(window);
