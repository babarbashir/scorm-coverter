/*
 * Quiz viewer: intro -> one question per screen -> results/review.
 * Correct answers ship lightly obfuscated (see decodeKey); like every SCORM
 * quiz they are checked in the browser, so this deters casual peeking only.
 * ES5 on purpose; see scorm-api.js.
 */
(function (window, document) {
  'use strict';

  var U = window.PlayerUtil;
  var LETTERS = 'abcdefgh';

  function decodeKey(k, salt) {
    var bin = window.atob(k), out = '';
    for (var i = 0; i < bin.length; i++) {
      out += String.fromCharCode(bin.charCodeAt(i) ^ salt.charCodeAt(i % salt.length) ^ ((i * 31) & 255));
    }
    return out.split(',').map(function (n) { return parseInt(n, 10); });
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function range(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }

  window.Viewers.quiz = function (stage, ctx) {
    var item = ctx.item, quiz = item.quiz, state = ctx.state, cfg = ctx.config;
    var total = quiz.drawCount || quiz.questions.length;
    var root = U.el('div', { 'class': 'quiz-view' });
    stage.appendChild(root);

    var correctSets = quiz.questions.map(function (q, i) { return decodeKey(q.k, item.id + ':' + i); });

    function attemptsLeft() {
      return quiz.maxAttempts ? Math.max(0, quiz.maxAttempts - state.attempts) : Infinity;
    }

    function card() {
      root.innerHTML = '';
      var c = U.el('div', { 'class': 'quiz-card' });
      root.appendChild(c);
      stage.scrollTop = 0;
      return c;
    }

    function button(label, cls, onClick) {
      var b = U.el('button', { 'class': 'btn ' + (cls || ''), type: 'button' }, label);
      b.onclick = onClick;
      return b;
    }

    // ---------------------------------------------------------------
    // Intro
    // ---------------------------------------------------------------
    function intro() {
      var c = card();
      c.appendChild(U.text('h2', { 'class': 'quiz-title' }, item.title));
      var facts = U.el('ul', { 'class': 'quiz-facts' });
      facts.appendChild(U.text('li', null, total + ' question' + (total === 1 ? '' : 's')));
      facts.appendChild(U.text('li', null, 'Pass mark ' + quiz.passMark + '%'));
      facts.appendChild(U.text('li', null, quiz.maxAttempts ? quiz.maxAttempts + ' attempt' + (quiz.maxAttempts === 1 ? '' : 's') + ' allowed' : 'Unlimited attempts'));
      c.appendChild(facts);

      var actions = U.el('div', { 'class': 'quiz-actions' });
      if (state.passed) {
        c.appendChild(U.el('p', { 'class': 'quiz-banner pass' }, 'You passed this quiz. Your best score is <b>' + Math.round(state.best) + '%</b>.'));
        if (ctx.hasNext()) actions.appendChild(button('Continue &#8250;', 'primary', ctx.next));
      } else if (state.done) {
        c.appendChild(U.el('p', { 'class': 'quiz-banner fail' }, 'You have used all your attempts. Your best score is <b>' + Math.round(state.best) + '%</b>.'));
        if (ctx.hasNext()) actions.appendChild(button('Continue &#8250;', '', ctx.next));
      } else {
        if (state.attempts) {
          c.appendChild(U.el('p', { 'class': 'quiz-banner' }, 'Best score so far: <b>' + Math.round(state.best) + '%</b>. ' +
            (quiz.maxAttempts ? attemptsLeft() + ' attempt' + (attemptsLeft() === 1 ? '' : 's') + ' left.' : '')));
        }
        actions.appendChild(button(state.attempts ? 'Retake quiz' : 'Start quiz', 'primary', start));
      }
      c.appendChild(actions);
    }

    // ---------------------------------------------------------------
    // Attempt
    // ---------------------------------------------------------------
    var attempt = null;

    function start() {
      var order = range(quiz.questions.length);
      if (quiz.shuffleQuestions || quiz.drawCount) shuffle(order);
      if (quiz.drawCount) order = order.slice(0, quiz.drawCount);
      attempt = {
        questions: order.map(function (qi) {
          var q = quiz.questions[qi];
          var opts = range(q.options.length);
          if (quiz.shuffleAnswers && q.type !== 'truefalse') shuffle(opts);
          return { qi: qi, opts: opts, answer: [] };
        }),
        index: 0,
      };
      show();
    }

    function show() {
      var a = attempt.questions[attempt.index];
      var q = quiz.questions[a.qi];
      var n = attempt.questions.length;
      var c = card();

      var head = U.el('div', { 'class': 'quiz-progress' });
      head.appendChild(U.text('span', null, 'Question ' + (attempt.index + 1) + ' of ' + n));
      var bar = U.el('div', { 'class': 'quiz-bar' });
      var fill = U.el('span');
      fill.style.width = Math.round((attempt.index / n) * 100) + '%';
      bar.appendChild(fill);
      head.appendChild(bar);
      c.appendChild(head);

      var fs = U.el('fieldset', { 'class': 'quiz-q' });
      var legend = U.text('legend', null, q.text);
      fs.appendChild(legend);
      if (q.type === 'multiple') fs.appendChild(U.text('p', { 'class': 'quiz-hint' }, 'Select all that apply.'));

      var name = 'q_' + item.id + '_' + attempt.index;
      var nextBtn;
      a.opts.forEach(function (oi) {
        var label = U.el('label', { 'class': 'quiz-opt' });
        var input = U.el('input', { type: q.type === 'multiple' ? 'checkbox' : 'radio', name: name, value: String(oi) });
        if (a.answer.indexOf(oi) >= 0) { input.checked = true; label.className += ' selected'; }
        input.onchange = function () {
          if (q.type === 'multiple') {
            a.answer = [];
            var boxes = fs.querySelectorAll('input');
            for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) a.answer.push(parseInt(boxes[i].value, 10));
          } else {
            a.answer = [oi];
          }
          var labels = fs.querySelectorAll('.quiz-opt');
          for (var j = 0; j < labels.length; j++) {
            labels[j].className = 'quiz-opt' + (labels[j].querySelector('input').checked ? ' selected' : '');
          }
          nextBtn.disabled = !a.answer.length;
        };
        label.appendChild(input);
        label.appendChild(U.text('span', null, q.options[oi]));
        fs.appendChild(label);
      });
      c.appendChild(fs);

      var actions = U.el('div', { 'class': 'quiz-actions' });
      var back = button('&#8249; Back', '', function () { attempt.index--; show(); });
      back.disabled = attempt.index === 0;
      actions.appendChild(back);
      var last = attempt.index === n - 1;
      nextBtn = button(last ? 'Submit answers' : 'Next &#8250;', 'primary', function () {
        if (!a.answer.length) return;
        if (last) submit(); else { attempt.index++; show(); }
      });
      nextBtn.disabled = !a.answer.length;
      actions.appendChild(nextBtn);
      c.appendChild(actions);

      var first = fs.querySelector('input');
      if (first && attempt.index > 0) first.focus();
    }

    function sameSet(a, b) {
      if (a.length !== b.length) return false;
      var x = a.slice().sort(), y = b.slice().sort();
      for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    }

    function submit() {
      var right = 0;
      attempt.questions.forEach(function (a) {
        var correct = correctSets[a.qi];
        a.correct = sameSet(a.answer, correct);
        if (a.correct) right++;
        if (cfg.recordInteractions) {
          window.ScormRuntime.recordInteraction({
            id: item.id + '_Q' + (a.qi + 1),
            description: quiz.questions[a.qi].text,
            response: a.answer.slice().sort().map(function (i) { return LETTERS.charAt(i); }),
            correct: correct.map(function (i) { return LETTERS.charAt(i); }),
            result: a.correct,
          });
        }
      });
      var n = attempt.questions.length;
      var pct = Math.round((right / n) * 10000) / 100;
      var passed = pct >= quiz.passMark;
      ctx.quizResult(pct, passed);
      results(right, n, pct, passed);
    }

    // ---------------------------------------------------------------
    // Results
    // ---------------------------------------------------------------
    function results(right, n, pct, passed) {
      var c = card();
      var badge = U.el('div', { 'class': 'quiz-score ' + (passed ? 'pass' : 'fail') });
      badge.appendChild(U.text('span', { 'class': 'quiz-pct' }, Math.round(pct) + '%'));
      badge.appendChild(U.text('span', { 'class': 'quiz-verdict' }, passed ? 'Passed' : 'Not passed'));
      c.appendChild(badge);
      c.appendChild(U.text('p', { 'class': 'quiz-summary' },
        'You answered ' + right + ' of ' + n + ' correctly. The pass mark is ' + quiz.passMark + '%.'));

      var left = attemptsLeft();
      if (!passed) {
        c.appendChild(U.text('p', { 'class': 'quiz-summary' }, left === 0
          ? 'You have no attempts left.'
          : (left === Infinity ? 'You can try again.' : 'You have ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left.')));
      }

      var actions = U.el('div', { 'class': 'quiz-actions' });
      if (!passed && left > 0) actions.appendChild(button('Retake quiz', 'primary', start));
      if (ctx.hasNext()) actions.appendChild(button('Continue &#8250;', passed ? 'primary' : '', ctx.next));
      c.appendChild(actions);

      // Correct answers are only revealed once they can no longer help with a retake.
      var reveal = quiz.feedback === 'answers' && (passed || left === 0);
      if (quiz.feedback !== 'none') review(c, reveal);
    }

    function review(c, reveal) {
      c.appendChild(U.text('h3', { 'class': 'quiz-review-title' }, 'Review'));
      if (!reveal && quiz.feedback === 'answers') {
        c.appendChild(U.text('p', { 'class': 'quiz-hint' }, 'Correct answers are shown after you pass or use all your attempts.'));
      }
      var list = U.el('ol', { 'class': 'quiz-review' });
      attempt.questions.forEach(function (a) {
        var q = quiz.questions[a.qi];
        var li = U.el('li', { 'class': a.correct ? 'right' : 'wrong' });
        var head = U.el('div', { 'class': 'qr-head' });
        head.appendChild(U.text('span', { 'class': 'qr-mark' }, a.correct ? '✓ Correct' : '✗ Incorrect'));
        head.appendChild(U.text('span', { 'class': 'qr-text' }, q.text));
        li.appendChild(head);
        if (reveal) {
          var ul = U.el('ul', { 'class': 'qr-opts' });
          a.opts.forEach(function (oi) {
            var isCorrect = correctSets[a.qi].indexOf(oi) >= 0;
            var chosen = a.answer.indexOf(oi) >= 0;
            var o = U.text('li', { 'class': (isCorrect ? 'is-correct' : '') + (chosen ? ' is-chosen' : '') }, q.options[oi]);
            if (chosen) o.appendChild(U.text('span', { 'class': 'qr-tag' }, 'Your answer'));
            ul.appendChild(o);
          });
          li.appendChild(ul);
          if (q.feedback) li.appendChild(U.text('p', { 'class': 'qr-feedback' }, q.feedback));
        }
        list.appendChild(li);
      });
      c.appendChild(list);
    }

    intro();
    return { destroy: function () {} };
  };
})(window, document);
