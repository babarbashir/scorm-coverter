(function () {
  'use strict';

  const KINDS = { mp4: 'mp4', m4v: 'mp4', pdf: 'pdf', pptx: 'pptx', docx: 'docx' };
  const LETTERS = 'ABCDEFGH';
  const MAX_OPTIONS = 8;

  const $ = (id) => document.getElementById(id);
  let caps = { office: true, ffmpeg: true, maxBytes: 500 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 * 1024, maxItems: 30 };
  fetch('/api/capabilities').then((r) => r.json()).then((c) => { caps = { ...caps, ...c }; }).catch(() => {});

  const course = { items: [] };
  let titleTouched = false;
  let seq = 0;
  const newId = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }

  function prettyTitle(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function setError(id, msg) { $(id).textContent = msg || ''; }

  // ------------------------------------------------------------------
  // Items
  // ------------------------------------------------------------------
  function addFiles(list) {
    setError('file-error', '');
    const errors = [];
    for (const f of list) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const kind = KINDS[ext];
      if (!kind) { errors.push(`${f.name}: unsupported type`); continue; }
      if (f.size > caps.maxBytes) { errors.push(`${f.name}: ${fmtBytes(f.size)} is over the 500 MB limit`); continue; }
      if (!f.size) { errors.push(`${f.name}: empty file`); continue; }
      if ((kind === 'pptx' || kind === 'docx') && caps.office === false) { errors.push(`${f.name}: LibreOffice is not installed on the server`); continue; }
      if (course.items.length >= caps.maxItems) { errors.push(`A course can have at most ${caps.maxItems} items`); break; }
      course.items.push({
        id: newId('f'), type: 'file', file: f, kind, title: prettyTitle(f.name), required: true,
        threshold: kind === 'mp4' ? 95 : 100, restrictSeek: false,
      });
    }
    if (errors.length) setError('file-error', errors.join(' · '));
    if (!titleTouched && course.items.length) $('title').value = course.items.length === 1 ? course.items[0].title : ($('title').value || course.items[0].title);
    render();
  }

  // parent: a file item to attach the quiz to (it then sits right after it).
  function addQuiz(parent) {
    if (course.items.length >= caps.maxItems) return setError('file-error', `A course can have at most ${caps.maxItems} items`);
    const quiz = {
      id: newId('q'), type: 'quiz', title: parent ? `${parent.title}: Quiz` : 'Knowledge check', required: true,
      quiz: { passMark: 80, maxAttempts: 0, drawCount: 0, shuffleQuestions: true, shuffleAnswers: false, feedback: 'answers', questions: [] },
      attachedTo: parent ? parent.id : null,
      isNew: true,
    };
    openQuizEditor(quiz);
  }

  function attachedQuiz(file) {
    const next = course.items[course.items.indexOf(file) + 1];
    return next && next.attachedTo === file.id ? next : null;
  }

  // A file and the quiz attached to it move and delete as one block.
  function groups() {
    const out = [];
    for (let i = 0; i < course.items.length; i++) {
      const it = course.items[i];
      const quiz = it.type === 'file' ? attachedQuiz(it) : null;
      if (quiz) { out.push([it, quiz]); i++; } else out.push([it]);
    }
    return out;
  }

  function move(g, d) {
    const gs = groups();
    const j = g + d;
    if (j < 0 || j >= gs.length) return;
    [gs[g], gs[j]] = [gs[j], gs[g]];
    course.items = gs.flat();
    render();
    const btn = document.querySelectorAll('#items .it-order')[j];
    const target = btn && btn.querySelector(`.mv-${d < 0 ? 'up' : 'down'}`);
    if (target && !target.disabled) target.focus();
  }

  function remove(it) {
    const quiz = it.type === 'file' ? attachedQuiz(it) : null;
    if (quiz && quiz.quiz.questions.length && !confirm(`Also remove its quiz "${quiz.title}" (${quiz.quiz.questions.length} questions)?`)) return;
    course.items = course.items.filter((x) => x !== it && x !== quiz);
    render();
  }

  const BADGE = { pdf: 'PDF', mp4: 'MP4', pptx: 'PPTX', docx: 'DOCX', quiz: 'QUIZ' };

  // g: group index (for reordering); i: section number in the course.
  function itemRow(it, i, g, groupCount) {
    const kind = it.type === 'quiz' ? 'quiz' : it.kind;
    const attached = it.type === 'quiz' && it.attachedTo && course.items[i - 1] && course.items[i - 1].id === it.attachedTo;

    let meta, settings;
    if (it.type === 'quiz') {
      const q = it.quiz;
      const count = q.questions.length;
      const draws = q.drawCount && q.drawCount < count ? `${q.drawCount} of ${count} questions` : `${count} question${count === 1 ? '' : 's'}`;
      meta = `${draws} · pass mark ${q.passMark}% · ${q.maxAttempts ? q.maxAttempts + ' attempt' + (q.maxAttempts > 1 ? 's' : '') : 'unlimited attempts'}`;
      settings = h('div', { class: 'it-settings' },
        h('button', { type: 'button', class: 'btn small', onclick: () => openQuizEditor(it) }, 'Edit questions & settings'));
    } else {
      meta = `${it.file.name} · ${fmtBytes(it.file.size)}`;
      const isVideo = it.kind === 'mp4';
      const thr = h('input', {
        type: 'number', min: '1', max: '100', value: String(it.threshold), class: 'num', 'aria-label': 'Completion percentage',
        onchange: (e) => { it.threshold = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 100)); e.target.value = it.threshold; },
      });
      settings = h('div', { class: 'it-settings' },
        h('label', { class: 'inline' }, 'Complete when ', thr, isVideo ? '% watched' : `% of ${it.kind === 'pptx' ? 'slides' : 'pages'} viewed`),
        isVideo ? h('label', { class: 'check inline' },
          h('input', { type: 'checkbox', checked: it.restrictSeek, onchange: (e) => { it.restrictSeek = e.target.checked; } }),
          h('span', {}, 'No skipping ahead')) : null,
        attachedQuiz(it) ? null : h('button', {
          type: 'button', class: 'btn small add-attached', onclick: () => addQuiz(it),
          title: 'Add a quiz that follows this section',
        }, '+ Add quiz'));
    }

    const order = attached
      ? h('div', { class: 'it-order attached-mark', 'aria-hidden': 'true' }, h('span', { class: 'it-num' }, String(i + 1)))
      : h('div', { class: 'it-order' },
        h('button', { type: 'button', class: 'icon-btn mv-up', 'aria-label': `Move ${it.title} up`, disabled: g === 0, onclick: () => move(g, -1) }, '↑'),
        h('span', { class: 'it-num' }, String(i + 1)),
        h('button', { type: 'button', class: 'icon-btn mv-down', 'aria-label': `Move ${it.title} down`, disabled: g === groupCount - 1, onclick: () => move(g, 1) }, '↓'));

    return h('li', { class: attached ? 'item attached' : 'item' },
      order,
      h('span', { class: `file-badge ${kind}` }, BADGE[kind]),
      h('div', { class: 'it-main' },
        h('input', {
          type: 'text', class: 'it-title', value: it.title, maxlength: '200', 'aria-label': 'Section title',
          oninput: (e) => { it.title = e.target.value; },
          onblur: (e) => { if (!e.target.value.trim()) { e.target.value = it.title = it.type === 'quiz' ? 'Quiz' : prettyTitle(it.file.name); } },
        }),
        h('div', { class: 'it-meta' }, attached ? `Quiz for "${course.items[i - 1].title}" · ${meta}` : meta),
        settings),
      h('div', { class: 'it-side' },
        h('label', { class: 'check inline', title: 'Required items count towards course completion' },
          h('input', { type: 'checkbox', checked: it.required, onchange: (e) => { it.required = e.target.checked; renderReport(); } }),
          h('span', {}, 'Required')),
        h('button', {
          type: 'button', class: 'icon-btn danger', 'aria-label': `Remove ${it.title}`,
          onclick: () => remove(it),
        }, '×')));
  }

  function render() {
    const list = $('items');
    const gs = groups();
    const rows = [];
    let i = 0;
    gs.forEach((grp, g) => grp.forEach((it) => { rows.push(itemRow(it, i, g, gs.length)); i++; }));
    list.replaceChildren(...rows);
    const files = course.items.filter((x) => x.type === 'file');
    const quizzes = course.items.filter((x) => x.type === 'quiz');
    const total = files.reduce((n, x) => n + x.file.size, 0);
    $('content-summary').textContent = course.items.length
      ? `${files.length} file${files.length === 1 ? '' : 's'}${quizzes.length ? ` · ${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'}` : ''}${total ? ` · ${fmtBytes(total)}` : ''}`
      : '';
    $('drop').classList.toggle('compact', course.items.length > 0);
    $('build').disabled = !course.items.length;
    if (total > caps.maxTotalBytes) setError('build-error', `Files add up to ${fmtBytes(total)}; the limit per course is 2 GB.`);
    else setError('build-error', '');
    renderReport();
  }

  function renderReport() {
    const quizzes = course.items.filter((x) => x.type === 'quiz');
    const reqQuizzes = quizzes.filter((x) => x.required);
    const v12 = document.querySelector('input[name=version]:checked').value === '1.2';
    document.querySelectorAll('.quiz-only').forEach((el) => { el.hidden = !quizzes.length; });
    document.querySelectorAll('.no-quiz').forEach((el) => { el.hidden = reqQuizzes.length > 0; });

    const rows = [['Completion', 'When every required section is completed']];
    if (reqQuizzes.length) {
      rows.push(['Pass / fail', reqQuizzes.length === 1
        ? `From "${reqQuizzes[0].title}" (pass mark ${reqQuizzes[0].quiz.passMark}%). Failed only once all attempts are used.`
        : 'Passed when every required quiz is passed. Failed only once a quiz has no attempts left.']);
      rows.push(['Score', reqQuizzes.length === 1 ? 'Best quiz score (0–100)' : 'Combined best score across required quizzes, weighted by question count']);
      rows.push(['LMS status', v12
        ? 'SCORM 1.2 uses one status: incomplete, then passed or failed'
        : 'SCORM 2004 reports completion and pass/fail separately']);
    } else {
      rows.push(['Pass / fail', 'Not reported, as there is no required quiz (optional below)']);
    }
    $('report-box').replaceChildren(h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  }

  // ------------------------------------------------------------------
  // Drop zone
  // ------------------------------------------------------------------
  const drop = $('drop');
  $('files').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('add-files').addEventListener('click', () => $('files').click());
  $('add-quiz').addEventListener('click', () => addQuiz());
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('title').addEventListener('input', () => { titleTouched = true; });
  document.querySelectorAll('input[name=version]').forEach((r) => r.addEventListener('change', renderReport));
  window.addEventListener('beforeunload', (e) => {
    if (course.items.length && $('progress-card').hidden) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------
  // Quiz editor
  // ------------------------------------------------------------------
  const dlg = $('quiz-dialog');
  let editing = null;   // the item being edited
  let draft = null;     // working copy of its questions

  function blankQuestion(type = 'single') {
    return type === 'truefalse'
      ? { type, text: '', options: ['True', 'False'], correct: [], feedback: '' }
      : { type, text: '', options: ['', '', '', ''], correct: [], feedback: '' };
  }

  function openQuizEditor(item) {
    editing = item;
    const q = item.quiz;
    draft = JSON.parse(JSON.stringify(q.questions));
    if (!draft.length) draft.push(blankQuestion());
    $('qd-title').textContent = item.isNew ? 'New quiz' : 'Edit quiz';
    $('qd-name').value = item.title;
    $('qd-pass').value = q.passMark;
    $('qd-attempts').value = String(q.maxAttempts);
    if (![...$('qd-attempts').options].some((o) => o.value === String(q.maxAttempts))) {
      $('qd-attempts').append(h('option', { value: String(q.maxAttempts) }, String(q.maxAttempts)));
      $('qd-attempts').value = String(q.maxAttempts);
    }
    $('qd-draw').value = q.drawCount;
    $('qd-feedback').value = q.feedback;
    $('qd-shuffle-q').checked = q.shuffleQuestions;
    $('qd-shuffle-a').checked = q.shuffleAnswers;
    setError('qd-error', '');
    setError('qd-csv-msg', '');
    renderQuestions();
    dlg.showModal();
    $('qd-name').focus();
  }

  function questionCard(q, qi) {
    const isTF = q.type === 'truefalse';
    const multi = q.type === 'multiple';
    const name = `correct-${qi}`;

    const options = q.options.map((opt, oi) => h('li', { class: 'opt' },
      h('label', { class: 'opt-correct', title: 'Mark as correct' },
        h('input', {
          type: multi ? 'checkbox' : 'radio', name, checked: q.correct.includes(oi), 'aria-label': `Option ${LETTERS[oi]} is correct`,
          onchange: (e) => {
            if (multi) q.correct = e.target.checked ? [...new Set([...q.correct, oi])].sort() : q.correct.filter((x) => x !== oi);
            else q.correct = [oi];
          },
        }),
        h('span', { class: 'opt-letter' }, LETTERS[oi])),
      h('input', {
        type: 'text', value: opt, maxlength: '500', placeholder: `Option ${LETTERS[oi]}`, readonly: isTF, 'aria-label': `Option ${LETTERS[oi]}`,
        oninput: (e) => { q.options[oi] = e.target.value; },
      }),
      !isTF && q.options.length > 2 ? h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `Remove option ${LETTERS[oi]}`,
        onclick: () => {
          q.options.splice(oi, 1);
          q.correct = q.correct.filter((x) => x !== oi).map((x) => (x > oi ? x - 1 : x));
          renderQuestions();
        },
      }, '×') : null));

    return h('li', { class: 'qcard' },
      h('div', { class: 'qcard-head' },
        h('span', { class: 'qnum' }, `Q${qi + 1}`),
        h('select', {
          'aria-label': 'Question type',
          onchange: (e) => {
            const t = e.target.value;
            if (t === 'truefalse') { q.options = ['True', 'False']; q.correct = q.correct.filter((x) => x < 2).slice(0, 1); }
            else if (q.type === 'truefalse') { q.options = ['', '', '', '']; q.correct = []; }
            else if (t === 'single' && q.correct.length > 1) q.correct = q.correct.slice(0, 1);
            q.type = t;
            renderQuestions();
          },
        },
        h('option', { value: 'single', selected: q.type === 'single' }, 'Single choice'),
        h('option', { value: 'multiple', selected: q.type === 'multiple' }, 'Multiple response'),
        h('option', { value: 'truefalse', selected: q.type === 'truefalse' }, 'True / False')),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move question ${qi + 1} up`, disabled: qi === 0, onclick: () => { [draft[qi - 1], draft[qi]] = [draft[qi], draft[qi - 1]]; renderQuestions(); } }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move question ${qi + 1} down`, disabled: qi === draft.length - 1, onclick: () => { [draft[qi + 1], draft[qi]] = [draft[qi], draft[qi + 1]]; renderQuestions(); } }, '↓'),
        h('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Delete question ${qi + 1}`, onclick: () => { draft.splice(qi, 1); renderQuestions(); } }, '×')),
      h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Question text', 'aria-label': `Question ${qi + 1} text`, oninput: (e) => { q.text = e.target.value; } }, q.text),
      h('p', { class: 'hint' }, multi ? 'Tick every correct answer.' : 'Select the correct answer.'),
      h('ol', { class: 'opts' }, options),
      !isTF && q.options.length < MAX_OPTIONS ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { q.options.push(''); renderQuestions(); } }, '+ Add option') : null,
      h('input', { type: 'text', class: 'qfeedback', value: q.feedback || '', maxlength: '1000', placeholder: 'Explanation shown in the review (optional)', 'aria-label': 'Explanation', oninput: (e) => { q.feedback = e.target.value; } }));
  }

  function renderQuestions() {
    $('qd-questions').replaceChildren(...draft.map(questionCard));
    $('qd-count').textContent = `(${draft.length})`;
    $('qd-draw').max = String(draft.length);
  }

  function validateDraft() {
    if (!draft.length) return 'Add at least one question.';
    for (let i = 0; i < draft.length; i++) {
      const q = draft[i];
      const where = `Question ${i + 1}`;
      if (!q.text.trim()) return `${where}: enter the question text.`;
      const filled = q.options.filter((o) => o.trim());
      if (filled.length < 2) return `${where}: add at least two answer options.`;
      if (!q.correct.length) return `${where}: mark the correct answer.`;
      if (q.correct.some((c) => !q.options[c] || !q.options[c].trim())) return `${where}: a correct answer is blank.`;
      if (q.type !== 'multiple' && q.correct.length !== 1) return `${where}: choose exactly one correct answer.`;
    }
    return '';
  }

  $('qd-add').addEventListener('click', () => {
    const last = draft[draft.length - 1];
    draft.push(blankQuestion(last && last.type !== 'truefalse' ? last.type : 'single'));
    renderQuestions();
    const cards = document.querySelectorAll('#qd-questions .qcard textarea');
    cards[cards.length - 1].focus();
  });

  $('qd-save').addEventListener('click', () => {
    // Drop entirely empty trailing questions before validating.
    draft = draft.filter((q) => q.text.trim() || q.options.some((o) => o.trim() && !['True', 'False'].includes(o)) || q.correct.length);
    const err = validateDraft();
    if (err) { setError('qd-error', err); renderQuestions(); return; }
    const q = editing.quiz;
    editing.title = $('qd-name').value.trim() || 'Quiz';
    q.passMark = Math.max(0, Math.min(100, parseInt($('qd-pass').value, 10) || 0));
    q.maxAttempts = parseInt($('qd-attempts').value, 10) || 0;
    const draw = parseInt($('qd-draw').value, 10) || 0;
    q.drawCount = draw > 0 && draw < draft.length ? draw : 0;
    q.feedback = $('qd-feedback').value;
    q.shuffleQuestions = $('qd-shuffle-q').checked;
    q.shuffleAnswers = $('qd-shuffle-a').checked;
    q.questions = draft.map((x) => ({ ...x, options: x.options.map((o) => o.trim()), text: x.text.trim() }));
    if (editing.isNew) {
      delete editing.isNew;
      const parentIdx = course.items.findIndex((x) => x.id === editing.attachedTo);
      if (parentIdx >= 0) course.items.splice(parentIdx + 1, 0, editing);
      else { editing.attachedTo = null; course.items.push(editing); }
    }
    dlg.close();
    render();
  });

  const closeEditor = () => dlg.close();
  $('qd-cancel').addEventListener('click', closeEditor);
  $('qd-close').addEventListener('click', closeEditor);

  // ------------------------------------------------------------------
  // CSV import / export
  // ------------------------------------------------------------------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }

  function importCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('The file has no question rows.');
    const head = rows[0].map((x) => x.trim().toLowerCase());
    const col = (re) => head.findIndex((x) => re.test(x));
    const qCol = col(/^question|^text$/);
    const tCol = col(/^type/);
    const cCol = col(/^correct|^answer$/);
    const fCol = col(/^feedback|^explanation/);
    const optCols = head.map((x, i) => [x, i]).filter(([x]) => /^(option|answer|choice)\s*[a-h1-8]$|^[a-h]$/.test(x)).map(([, i]) => i);
    if (qCol < 0 || cCol < 0 || optCols.length < 2) throw new Error('Expected columns: Question, Type, Option A, Option B, …, Correct, Feedback. Use the CSV template.');

    const out = [];
    const problems = [];
    rows.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const text = (r[qCol] || '').trim();
      if (!text) return;
      let options = optCols.map((i) => (r[i] || '').trim());
      while (options.length && !options[options.length - 1]) options.pop();
      const correct = String(r[cCol] || '').toUpperCase().split(/[\s,;|/]+/).filter(Boolean).map((t) => {
        if (/^[A-H]$/.test(t)) return LETTERS.indexOf(t);
        if (/^[1-8]$/.test(t)) return parseInt(t, 10) - 1;
        if (t === 'TRUE') return 0;
        if (t === 'FALSE') return 1;
        return -1;
      });
      let type = String(tCol >= 0 ? r[tCol] || '' : '').trim().toLowerCase().replace(/[^a-z]/g, '');
      if (/^(tf|truefalse|boolean)$/.test(type)) type = 'truefalse';
      else if (/^(multiple|multi|mr|multipleresponse|checkbox)$/.test(type)) type = 'multiple';
      else if (/^(single|mcq|mc|singlechoice|multiplechoice|radio)$/.test(type)) type = 'single';
      else type = correct.length > 1 ? 'multiple' : (options.length === 2 && /^true$/i.test(options[0]) && /^false$/i.test(options[1]) ? 'truefalse' : 'single');
      if (type === 'truefalse') options = [options[0] || 'True', options[1] || 'False'];

      if (correct.some((c) => c < 0 || c >= options.length || !options[c])) { problems.push(`row ${line}: "Correct" doesn't match an option`); return; }
      if (options.filter(Boolean).length < 2) { problems.push(`row ${line}: needs at least two options`); return; }
      if (!correct.length) { problems.push(`row ${line}: the Correct column is empty`); return; }
      if (type !== 'multiple' && correct.length > 1) type = 'multiple';
      out.push({ type, text, options, correct: [...new Set(correct)].sort(), feedback: fCol >= 0 ? (r[fCol] || '').trim() : '' });
    });
    return { questions: out, problems };
  }

  $('qd-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { questions, problems } = importCSV(await f.text());
      if (!questions.length) throw new Error('No valid questions found. ' + problems.slice(0, 5).join('; '));
      // Replace the starter blank question; otherwise append.
      const onlyBlank = draft.length === 1 && !draft[0].text.trim();
      draft = onlyBlank ? questions : draft.concat(questions);
      renderQuestions();
      setError('qd-csv-msg', '');
      $('qd-csv-msg').append(h('span', { class: 'ok-msg' }, `Imported ${questions.length} question${questions.length === 1 ? '' : 's'}.`),
        problems.length ? ` Skipped ${problems.length}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '…' : ''}` : '');
    } catch (err) {
      setError('qd-csv-msg', err.message);
    }
  });

  $('qd-export').addEventListener('click', () => {
    const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const head = ['Question', 'Type', ...LETTERS.split('').map((l) => `Option ${l}`), 'Correct', 'Feedback'];
    const lines = [head.join(',')].concat(draft.map((q) => [
      esc(q.text), q.type,
      ...LETTERS.split('').map((_, i) => esc(q.options[i] || '')),
      esc(q.correct.map((c) => LETTERS[c]).join(';')), esc(q.feedback),
    ].join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${($('qd-name').value || 'quiz').replace(/[^\w-]+/g, '_')}.csv` });
    document.body.append(a); a.click(); a.remove();
  });

  // ------------------------------------------------------------------
  // Build
  // ------------------------------------------------------------------
  const bar = document.querySelector('#progress-card .bar');
  function progress(pct, label) {
    $('bar-fill').style.width = pct + '%';
    $('pct-text').textContent = Math.round(pct) + '%';
    if (label) $('stage-text').textContent = label;
  }
  function showError(msg) {
    bar.classList.add('error');
    $('job-error').textContent = msg;
    $('retry-row').hidden = false;
    $('pct-text').textContent = '';
    $('stage-text').textContent = 'Failed';
  }
  function backToBuilder() {
    $('progress-card').hidden = true;
    $('builder').hidden = false;
    $('done').hidden = true;
    $('retry-row').hidden = true;
    $('job-error').textContent = '';
    bar.classList.remove('error', 'done');
    progress(0, '');
  }
  $('retry').addEventListener('click', backToBuilder);
  $('edit-again').addEventListener('click', backToBuilder);
  $('start-over').addEventListener('click', () => {
    course.items = []; titleTouched = false; $('title').value = '';
    render(); backToBuilder();
  });

  $('build').addEventListener('click', () => {
    setError('build-error', '');
    if (!course.items.length) return;
    const quizMissing = course.items.find((x) => x.type === 'quiz' && !x.quiz.questions.length);
    if (quizMissing) return setError('build-error', `"${quizMissing.title}" has no questions.`);
    const total = course.items.filter((x) => x.type === 'file').reduce((n, x) => n + x.file.size, 0);
    if (total > caps.maxTotalBytes) return setError('build-error', `Files add up to ${fmtBytes(total)}; the limit per course is 2 GB.`);

    const version = document.querySelector('input[name=version]:checked').value;
    const title = $('title').value.trim() || course.items[0].title;
    const payload = {
      title,
      version,
      navigation: document.querySelector('input[name=navigation]:checked').value,
      passOnComplete: $('passOnComplete').checked,
      reportScore: $('reportScore').checked,
      recordInteractions: $('recordInteractions').checked,
      items: course.items.map((it) => (it.type === 'quiz'
        ? { id: it.id, type: 'quiz', title: it.title, required: it.required, quiz: it.quiz, attachedTo: it.attachedTo || null }
        : { id: it.id, type: 'file', title: it.title, required: it.required, threshold: it.threshold, restrictSeek: it.restrictSeek })),
    };
    const fd = new FormData();
    fd.append('course', JSON.stringify(payload));
    for (const it of course.items) if (it.type === 'file') fd.append(`file_${it.id}`, it.file, it.file.name);

    $('builder').hidden = true;
    $('progress-card').hidden = false;
    $('job-title').textContent = title;
    const fileCount = course.items.filter((x) => x.type === 'file').length;
    const quizCount = course.items.length - fileCount;
    $('job-sub').textContent = [
      `${course.items.length} section${course.items.length === 1 ? '' : 's'}`,
      fileCount ? `${fileCount} file${fileCount === 1 ? '' : 's'} (${fmtBytes(total)})` : null,
      quizCount ? `${quizCount} quiz${quizCount === 1 ? '' : 'zes'}` : null,
      document.querySelector('input[name=version]:checked + span').textContent,
    ].filter(Boolean).join(' · ');
    progress(0, total ? 'Uploading…' : 'Sending…');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/courses');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) progress((ev.loaded / ev.total) * 30, `Uploading… ${fmtBytes(ev.loaded)} of ${fmtBytes(ev.total)}`);
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status !== 202) return showError(body.error || `Upload failed (HTTP ${xhr.status})`);
      poll(body.id);
    };
    xhr.onerror = () => showError('Upload failed. Check your connection and try again.');
    xhr.send(fd);
  });

  function poll(id) {
    fetch(`/api/jobs/${id}`).then((r) => r.json().then((b) => ({ ok: r.ok, b }))).then(({ ok, b }) => {
      if (!ok) return showError(b.error || 'Conversion failed');
      if (b.status === 'error') return showError(b.error);
      progress(30 + b.progress * 0.7, b.stage);
      if (b.status === 'done') return finished(b);
      setTimeout(() => poll(id), 800);
    }).catch(() => setTimeout(() => poll(id), 2000));
  }

  function finished(job) {
    bar.classList.add('done');
    progress(100, 'Done');
    $('done').hidden = false;
    $('done-size').textContent = job.size ? ` (${fmtBytes(job.size)})` : '';
    $('download').href = job.downloadUrl;
    $('preview').href = job.previewUrl;
    $('warnings').replaceChildren(...(job.warnings || []).map((t) => h('li', {}, t)));
    $('download').focus();
  }

  render();
})();
