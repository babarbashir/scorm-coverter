'use strict';

// Course model sent by the builder UI, validated and normalised here so the
// player can trust it.
//
// {
//   title, version: '1.2'|'2004-3'|'2004-4',
//   navigation: 'free'|'sequential',
//   passOnComplete, reportScore, recordInteractions,
//   items: [
//     { id, type: 'file', title, required, threshold, restrictSeek }   // file uploaded as field "file:<id>"
//     { id, type: 'quiz', title, required, quiz: { passMark, maxAttempts, drawCount,
//         shuffleQuestions, shuffleAnswers, feedback: 'none'|'result'|'answers',
//         questions: [{ type: 'single'|'multiple'|'truefalse', text, options: [..], correct: [idx..], feedback }] } }
//   ]
// }

const { VERSIONS } = require('./manifest');

const LIMITS = {
  items: 30,
  questions: 300,
  options: 8,
  questionText: 2000,
  optionText: 500,
  feedback: 1000,
  title: 200,
};

class CourseError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function str(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function int(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function normalizeQuestion(q, i, quizTitle) {
  const where = `${quizTitle}, question ${i + 1}`;
  if (!q || typeof q !== 'object') throw new CourseError(`${where}: invalid question.`);
  const type = ['single', 'multiple', 'truefalse'].includes(q.type) ? q.type : 'single';
  const text = str(q.text, LIMITS.questionText);
  if (!text) throw new CourseError(`${where}: the question text is empty.`);

  const rawOptions = Array.isArray(q.options) ? q.options.map((o) => str(o, LIMITS.optionText)) : [];
  const rawCorrect = new Set((Array.isArray(q.correct) ? q.correct : []).map(Number));
  let options = [];
  let correct = [];
  if (type === 'truefalse') {
    options = [rawOptions[0] || 'True', rawOptions[1] || 'False'];
    correct = [0, 1].filter((i) => rawCorrect.has(i));
  } else {
    // Drop blank options, remapping correct indexes onto what remains.
    rawOptions.forEach((o, idx) => {
      if (!o) {
        if (rawCorrect.has(idx)) throw new CourseError(`${where}: a correct answer is blank.`);
        return;
      }
      if (rawCorrect.has(idx)) correct.push(options.length);
      options.push(o);
    });
  }
  if (options.length < 2) throw new CourseError(`${where}: needs at least two answer options.`);
  if (options.length > LIMITS.options) throw new CourseError(`${where}: no more than ${LIMITS.options} options are allowed.`);
  if (!correct.length) throw new CourseError(`${where}: mark at least one correct answer.`);
  if (type !== 'multiple' && correct.length !== 1) throw new CourseError(`${where}: single-choice questions need exactly one correct answer.`);

  return { type, text, options, correct, feedback: str(q.feedback, LIMITS.feedback) };
}

function normalizeQuiz(raw, title) {
  const q = raw || {};
  const questions = Array.isArray(q.questions) ? q.questions : [];
  if (!questions.length) throw new CourseError(`${title}: add at least one question.`);
  if (questions.length > LIMITS.questions) throw new CourseError(`${title}: no more than ${LIMITS.questions} questions are allowed.`);
  const normalized = questions.map((x, i) => normalizeQuestion(x, i, title));
  const drawCount = int(q.drawCount, 0, normalized.length, 0);
  return {
    passMark: int(q.passMark, 0, 100, 80),
    maxAttempts: int(q.maxAttempts, 0, 99, 0),
    drawCount: drawCount >= normalized.length ? 0 : drawCount,
    shuffleQuestions: q.shuffleQuestions !== false,
    shuffleAnswers: !!q.shuffleAnswers,
    feedback: ['none', 'result', 'answers'].includes(q.feedback) ? q.feedback : 'answers',
    questions: normalized,
  };
}

function normalizeCourse(raw) {
  if (!raw || typeof raw !== 'object') throw new CourseError('Invalid course data.');
  const items = Array.isArray(raw.items) ? raw.items : [];
  if (!items.length) throw new CourseError('Add at least one file or quiz.');
  if (items.length > LIMITS.items) throw new CourseError(`A course can have at most ${LIMITS.items} items.`);

  const seen = new Set();
  const out = items.map((it, i) => {
    const id = str(it && it.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || seen.has(id)) throw new CourseError(`Item ${i + 1} has a missing or duplicate id.`);
    seen.add(id);
    const title = str(it.title, LIMITS.title) || `Item ${i + 1}`;
    const base = { id, title, required: it.required !== false };
    if (it.type === 'quiz') return { ...base, type: 'quiz', quiz: normalizeQuiz(it.quiz, title) };
    if (it.type === 'file') {
      return { ...base, type: 'file', threshold: int(it.threshold, 1, 100, 100), restrictSeek: !!it.restrictSeek };
    }
    throw new CourseError(`Item ${i + 1} has an unknown type.`);
  });

  // A quiz can be attached to the file right before it (shown nested under
  // that file in the menu). Any other link is dropped.
  out.forEach((it, i) => {
    if (it.type !== 'quiz') return;
    const prev = out[i - 1];
    const want = str(items[i].attachedTo, 40);
    if (want && prev && prev.type === 'file' && prev.id === want) it.attachedTo = prev.id;
  });

  if (!out.some((it) => it.required)) out.forEach((it) => { it.required = true; });

  return {
    title: str(raw.title, LIMITS.title) || out[0].title,
    version: VERSIONS[raw.version] ? raw.version : '1.2',
    navigation: raw.navigation === 'sequential' ? 'sequential' : 'free',
    passOnComplete: !!raw.passOnComplete,
    reportScore: !!raw.reportScore,
    recordInteractions: raw.recordInteractions !== false,
    items: out,
  };
}

module.exports = { normalizeCourse, CourseError, LIMITS };
