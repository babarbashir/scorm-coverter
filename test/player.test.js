'use strict';

// Boots a real staged package (index.html + player scripts) in jsdom against
// a mock LMS, drives the quizzes like a learner, and checks what the LMS
// receives. Covers the course shell, sequencing, quiz scoring and resume.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { stagePackage } = require('../src/packager');
const { normalizeCourse } = require('../src/course');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const QUIZ = (passMark, maxAttempts) => ({
  passMark, maxAttempts, shuffleQuestions: false, feedback: 'answers',
  questions: [
    { type: 'single', text: 'Q1', options: ['right', 'wrong'], correct: [0] },
    { type: 'multiple', text: 'Q2', options: ['right', 'wrong', 'right too'], correct: [0, 2] },
  ],
});

async function stage(version, navigation = 'sequential') {
  const course = normalizeCourse({
    title: 'Two quizzes', version, navigation,
    items: [
      { id: 'qa', type: 'quiz', title: 'Quiz A', quiz: QUIZ(50, 0) },
      { id: 'qb', type: 'quiz', title: 'Quiz B', quiz: QUIZ(100, 2) },
    ],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scormplayer-'));
  await stagePackage(dir, course, {}, { id: 'TEST' });
  return dir;
}

// Launches the package; `lms` persists across launches like an LMS record.
async function launch(dir, version, lms) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const set = (k, v) => { lms[k] = String(v); return 'true'; };
  const get = (k) => {
    if (k === 'cmi.interactions._count') return String(Object.keys(lms).filter((x) => /^cmi\.interactions\.\d+\.id$/.test(x)).length);
    return lms[k] ?? '';
  };
  const api = version === '1.2'
    ? { LMSInitialize: () => 'true', LMSGetValue: get, LMSSetValue: set, LMSCommit: () => 'true', LMSFinish: () => 'true', LMSGetLastError: () => '0', LMSGetErrorString: () => '' }
    : { Initialize: () => 'true', GetValue: get, SetValue: set, Commit: () => 'true', Terminate: () => 'true', GetLastError: () => '0', GetErrorString: () => '' };
  const dom = await JSDOM.fromFile(path.join(dir, 'index.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      if (version === '1.2') win.API = api; else win.API_1484_11 = api;
      win.atob = (s) => Buffer.from(s, 'base64').toString('latin1');
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await wait(50);
  return { dom, d: dom.window.document, errors };
}

function menu(d) {
  return [...d.querySelectorAll('.menu-item')].map((b) => b.querySelector('.mi-status').textContent + (b.disabled ? ' [locked]' : ''));
}

// Takes the open quiz, answering each question with the given option labels.
function takeQuiz(d, answers) {
  const start = [...d.querySelectorAll('.quiz-card button')].find((b) => /Start|Retake/.test(b.textContent));
  start.click();
  for (const labels of answers) {
    for (const label of d.querySelectorAll('.quiz-opt')) {
      if (labels.includes(label.textContent)) label.querySelector('input').click();
    }
    [...d.querySelectorAll('.quiz-actions button')].pop().click();
  }
  return d.querySelector('.quiz-pct').textContent;
}

for (const version of ['1.2', '2004-4']) {
  const v12 = version === '1.2';
  const status = (lms) => (v12 ? lms['cmi.core.lesson_status'] : `${lms['cmi.completion_status']}/${lms['cmi.success_status'] || 'unknown'}`);
  const score = (lms) => lms[v12 ? 'cmi.core.score.raw' : 'cmi.score.raw'];

  test(`player: sequencing, scoring and resume (SCORM ${version})`, async () => {
    const dir = await stage(version);
    const lms = {};
    try {
      let { dom, d, errors } = await launch(dir, version, lms);
      assert.deepEqual(errors, []);
      assert.deepEqual(menu(d), ['2 questions', 'Locked [locked]']);

      // Quiz A: 1 of 2 right = 50%, which meets its 50% pass mark.
      assert.equal(takeQuiz(d, [['right'], ['wrong']]), '50%');
      assert.deepEqual(menu(d), ['Passed · 50%', '2 questions']);
      assert.equal(score(lms), '25', 'combined score: 50% of A, nothing yet for B');
      assert.equal(status(lms), v12 ? 'incomplete' : 'incomplete/unknown');

      // Quiz B attempt 1: 50%, below its 100% pass mark.
      d.querySelector('#next-item').click();
      assert.equal(takeQuiz(d, [['right'], ['right']]), '50%');
      assert.equal(status(lms), v12 ? 'incomplete' : 'incomplete/unknown', 'not failed while attempts remain');
      assert.equal(lms[v12 ? 'cmi.core.exit' : 'cmi.exit'], undefined);

      // Relaunch: progress and attempts survive.
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      assert.equal(lms[v12 ? 'cmi.core.exit' : 'cmi.exit'], 'suspend');
      dom.window.close();
      ({ dom, d, errors } = await launch(dir, version, lms));
      assert.deepEqual(menu(d), ['Passed · 50%', 'Best 50%']);
      assert.equal(d.querySelector('#item-title').textContent, 'Quiz B', 'resumes in the last section');

      // Quiz B attempt 2 (last): 100% => course passed.
      assert.equal(takeQuiz(d, [['right'], ['right', 'right too']]), '100%');
      assert.equal(status(lms), v12 ? 'passed' : 'completed/passed');
      assert.equal(score(lms), '75', 'combined best score: (50 + 100) / 2');
      if (!v12) assert.equal(lms['cmi.score.scaled'], '0.75');

      const ids = Object.keys(lms).filter((k) => /^cmi\.interactions\.\d+\.id$/.test(k)).map((k) => lms[k]);
      assert.deepEqual(ids, ['qa_Q1', 'qa_Q2', 'qb_Q1', 'qb_Q2', 'qb_Q1', 'qb_Q2']);
      assert.ok(lms[v12 ? 'cmi.suspend_data' : 'cmi.suspend_data'].length < 100);

      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      assert.equal(lms[v12 ? 'cmi.core.exit' : 'cmi.exit'], v12 ? '' : 'normal');
      assert.deepEqual(errors, []);
      dom.window.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`player: failing the last attempt reports failed (SCORM ${version})`, async () => {
    const dir = await stage(version, 'free');
    const lms = {};
    try {
      const { dom, d, errors } = await launch(dir, version, lms);
      d.querySelectorAll('.menu-item')[1].click();
      takeQuiz(d, [['wrong'], ['wrong']]);
      assert.equal(status(lms), v12 ? 'incomplete' : 'incomplete/unknown');
      assert.match(d.querySelector('.quiz-card').textContent, /1 attempt left/);
      assert.equal(d.querySelector('.qr-opts'), null, 'answers hidden while a retake is possible');
      takeQuiz(d, [['right'], ['wrong']]);
      assert.equal(status(lms), v12 ? 'failed' : 'incomplete/failed');
      assert.ok(d.querySelector('.qr-opts'), 'answers revealed after the final attempt');
      assert.ok(![...d.querySelectorAll('.quiz-card button')].some((b) => /Retake/.test(b.textContent)));
      assert.deepEqual(errors, []);
      dom.window.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
