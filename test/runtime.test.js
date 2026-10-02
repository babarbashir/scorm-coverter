'use strict';

// Unit tests for templates/player/scorm-api.js status rules, run in a
// sandbox against a recording mock LMS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'templates', 'player', 'scorm-api.js'), 'utf8');

function boot(version, initial = {}) {
  const data = { ...initial };
  const calls = [];
  const set = (k, v) => { calls.push([k, v]); data[k] = v; return 'true'; };
  const get = (k) => (k === 'cmi.interactions._count' ? String(Object.keys(data).filter((x) => /^cmi\.interactions\.\d+\.id$/.test(x)).length) : (data[k] ?? ''));
  const api = version === '1.2'
    ? { LMSInitialize: () => 'true', LMSGetValue: get, LMSSetValue: set, LMSCommit: () => 'true', LMSFinish: () => 'true', LMSGetLastError: () => '0', LMSGetErrorString: () => '' }
    : { Initialize: () => 'true', GetValue: get, SetValue: set, Commit: () => 'true', Terminate: () => 'true', GetLastError: () => '0', GetErrorString: () => '' };
  const win = { SCORM_CONFIG: { version }, addEventListener() {}, setTimeout, clearTimeout };
  win.parent = win;
  if (version === '1.2') win.API = api; else win.API_1484_11 = api;
  const ctx = { window: win, document: { addEventListener() {}, visibilityState: 'visible' }, setTimeout, clearTimeout, JSON };
  vm.runInNewContext(SRC, ctx);
  const rt = win.ScormRuntime;
  const saved = rt.start();
  return { rt, data, calls, saved };
}

test('1.2: incomplete -> passed with score, never downgraded', () => {
  const { rt, data } = boot('1.2', { 'cmi.core.lesson_status': 'not attempted' });
  assert.equal(data['cmi.core.lesson_status'], 'incomplete');
  rt.report({ completed: false, success: 'unknown', score: 50 });
  assert.equal(data['cmi.core.lesson_status'], 'incomplete');
  assert.equal(data['cmi.core.score.raw'], '50');
  rt.report({ completed: true, success: 'passed', score: 90 });
  assert.equal(data['cmi.core.lesson_status'], 'passed');
  assert.equal(data['cmi.core.score.raw'], '90');
  rt.report({ completed: true, success: 'failed', score: 10 });
  assert.equal(data['cmi.core.lesson_status'], 'passed', 'passed is never downgraded');
});

test('1.2: failed only when final, can later become passed', () => {
  const { rt, data } = boot('1.2', { 'cmi.core.lesson_status': 'incomplete' });
  rt.report({ completed: true, success: 'failed', score: 40 });
  assert.equal(data['cmi.core.lesson_status'], 'failed');
  rt.report({ completed: true, success: 'unknown', score: 40 });
  assert.equal(data['cmi.core.lesson_status'], 'failed', 'failed does not fall back to completed');
  rt.report({ completed: true, success: 'passed', score: 80 });
  assert.equal(data['cmi.core.lesson_status'], 'passed');
});

test('1.2: content-only course goes to completed; exit suspend vs normal', () => {
  const { rt, data } = boot('1.2', {});
  rt.finish();
  assert.equal(data['cmi.core.exit'], 'suspend');
  assert.match(data['cmi.core.session_time'], /^\d{2,4}:\d{2}:\d{2}\.\d{2}$/);

  const b = boot('1.2', {});
  b.rt.report({ completed: true, success: 'unknown', score: null });
  assert.equal(b.data['cmi.core.lesson_status'], 'completed');
  b.rt.finish();
  assert.equal(b.data['cmi.core.exit'], '');
});

test('2004: completion and success reported separately', () => {
  const { rt, data } = boot('2004', { 'cmi.completion_status': 'unknown', 'cmi.success_status': 'unknown' });
  assert.equal(data['cmi.completion_status'], 'incomplete');
  rt.report({ completed: false, success: 'passed', score: 100 });
  assert.equal(data['cmi.success_status'], 'passed');
  assert.equal(data['cmi.completion_status'], 'incomplete', 'passing the quiz alone does not complete the course');
  assert.equal(data['cmi.score.scaled'], '1');
  rt.report({ completed: true, success: 'passed', score: 87.5 });
  assert.equal(data['cmi.completion_status'], 'completed');
  assert.equal(data['cmi.score.raw'], '87.5');
  assert.equal(data['cmi.score.scaled'], '0.875');
  rt.report({ completed: true, success: 'failed', score: 0 });
  assert.equal(data['cmi.success_status'], 'passed', 'passed is never downgraded');
  rt.finish();
  assert.equal(data['cmi.exit'], 'normal');
  assert.match(data['cmi.session_time'], /^PT\d+H\d+M[\d.]+S$/);
});

test('2004: progress_measure stops once completed', () => {
  const { rt, data, calls } = boot('2004', {});
  rt.save('0:1', 'v2|0', 0.5);
  assert.equal(data['cmi.progress_measure'], '0.50');
  rt.report({ completed: true, success: 'unknown', score: null });
  const before = calls.length;
  rt.save('0:2', 'v2|1', 0.3);
  assert.ok(!calls.slice(before).some(([k]) => k === 'cmi.progress_measure'));
});

test('interactions are written in order with version-specific formats', () => {
  const a = boot('1.2', {});
  a.rt.recordInteraction({ id: 'quiz 1_Q1', description: 'x', response: ['a', 'c'], correct: ['a', 'c'], result: true });
  a.rt.recordInteraction({ id: 'q_Q2', response: ['b'], correct: ['a'], result: false });
  const k12 = a.calls.map(([k]) => k);
  assert.equal(k12[k12.indexOf('cmi.interactions.0.id') + 1], 'cmi.interactions.0.type', 'id is set first');
  assert.equal(a.data['cmi.interactions.0.id'], 'quiz_1_Q1', 'id has no spaces');
  assert.equal(a.data['cmi.interactions.0.student_response'], 'a,c');
  assert.equal(a.data['cmi.interactions.0.result'], 'correct');
  assert.equal(a.data['cmi.interactions.1.result'], 'wrong');
  assert.match(a.data['cmi.interactions.0.time'], /^\d{2}:\d{2}:\d{2}$/);

  const b = boot('2004', { 'cmi.interactions.0.id': 'existing' });
  b.rt.recordInteraction({ id: 'q_Q1', description: 'Pick', response: ['a', 'c'], correct: ['a', 'c'], result: false });
  assert.equal(b.data['cmi.interactions.1.id'], 'q_Q1', 'appends after existing interactions');
  assert.equal(b.data['cmi.interactions.1.learner_response'], 'a[,]c');
  assert.equal(b.data['cmi.interactions.1.result'], 'incorrect');
  assert.match(b.data['cmi.interactions.1.timestamp'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('review mode writes nothing', () => {
  const { rt, calls } = boot('2004', { 'cmi.mode': 'review', 'cmi.completion_status': 'completed' });
  const before = calls.length;
  rt.report({ completed: true, success: 'passed', score: 100 });
  rt.recordInteraction({ id: 'x', response: ['a'], correct: ['a'], result: true });
  rt.save('1', 'v2|1', 1);
  assert.equal(calls.length, before);
});
