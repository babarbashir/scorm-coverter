# SCORM Course Builder

Build **SCORM 1.2**, **SCORM 2004 3rd Edition** or **SCORM 2004 4th Edition** courses from **MP4, PDF, PPTX and DOCX** files (up to 500 MB each, 2 GB per course), with **quizzes, pass marks and score reporting**.

A course can be one file, several files, or files plus quizzes, for example *intro video → policy PDF → slides → quiz*. Learners get a menu, resume, and optional sequential unlocking. The LMS gets completion, pass/fail, a score and each answer.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000:

1. **Course**: title and SCORM version.
2. **Content**: drop in files (several at once), add quizzes, reorder, rename, and mark sections as required or optional. Set completion per file (% of pages viewed or % of video watched, with optional no-skipping).
3. **Rules & reporting**: free or sequential navigation. A summary shows exactly what the LMS will receive.

Click **Build**. Then download the `.zip` or open it in the built-in **LMS simulator**. The simulator is a strict mock LMS that logs every SCORM call, enforces the data model and lets you exit and relaunch to test resume.

### Quizzes

- Single choice, multiple response and true/false questions, written in the editor or **imported from CSV** ([template](public/quiz-template.csv)). Questions can be exported back to CSV.
- Pass mark, attempts allowed (or unlimited), a random draw of *N* questions from a larger pool, and shuffling of questions and answers.
- Feedback after submitting: score only; score plus right/wrong; or score, right/wrong and the correct answers with explanations. Correct answers are **only revealed after the learner passes or uses all attempts**, so feedback can't be used to game a retake.
- Answer keys ship lightly obfuscated, not in plain text. Like every SCORM quiz, scoring runs in the browser, so this deters casual peeking but isn't secure against a determined learner.

CSV columns: `Question, Type, Option A … Option H, Correct, Feedback`. Type is `single`, `multiple` or `truefalse`, and is inferred if blank. Correct takes letters such as `B` or `A;C`.

### What the LMS receives

| | SCORM 1.2 | SCORM 2004 |
|---|---|---|
| Completion | `lesson_status` = `completed` when every required section is done | `completion_status` = `completed` |
| Pass/fail (with a required quiz) | `passed` when the quiz is passed and content is done; `failed` only once attempts run out | `success_status` = `passed` / `failed`, independent of completion |
| Score | `score.raw` 0–100, the best quiz score. With several quizzes, combined and weighted by question count | `score.raw` + `score.scaled` |
| Answers | `cmi.interactions` (choice), optional | `cmi.interactions` with description and timestamp |
| Resume | `lesson_location` + `suspend_data` | `location` + `suspend_data` + `progress_measure` |

Courses without a required quiz can optionally report `passed` and a score of 100 on completion, for LMSs that need them.

### Requirements

| Tool | Needed for | Notes |
|---|---|---|
| Node.js 18+ | everything | |
| LibreOffice | DOCX / PPTX | Found automatically on macOS, Linux and Windows. Set `SOFFICE_PATH` to override. |
| ffmpeg | MP4 optimisation | Installed automatically through the `ffmpeg-static` npm package. Set `FFMPEG_PATH` to use your own. |

Environment variables: `PORT` (default 3000), `HOST` (default `127.0.0.1`; use `0.0.0.0` to expose it on your network), `DATA_DIR`, `JOB_TTL_HOURS` (default 6, how long finished packages are kept).

## Design: one SCO with its own menu

Each course is packaged as **a single SCO with a built-in menu**, not one SCO per file. Multi-SCO packages depend on each LMS's own navigation and rollup rules. SCORM 1.2 has no rollup rules at all, and LMSs such as SuccessFactors and Cornerstone each handle multi-SCO packages differently. A single SCO behaves the same everywhere. Mainstream authoring tools take the same approach.

## What's in a package

```
imsmanifest.xml          single organization, single SCO, launches index.html
*.xsd / *.dtd            official ADL schema files for the chosen version
index.html               course player
player/                  scorm-api.js (LMS runtime), player.js (menu, rules, scoring),
                         viewers.js (PDF + video), quiz.js, player.css, config.js
player/pdfjs/            bundled PDF.js (only when the course has documents)
content/01-video.mp4     one file per section, plus posters
content/02-document.pdf
```

## LMS compatibility

- **ZIP format**: every entry stores its CRC and sizes in its local header, with no data descriptors. Java-based LMSs such as SAP SuccessFactors (Plateau) read packages with `ZipInputStream`, which rejects uncompressed entries that use descriptors (`only DEFLATED entries can have EXT descriptor`). The test suite reads every package the same way.
- **Manifest**: validated against the ADL XSDs for every version in the test suite. `imsmanifest.xml` is the first entry at the zip root, and every file is listed.
- **API discovery**: searches parent frames and then `window.opener`, and tolerates cross-origin frames, so it works with both frame-based and popup launches.
- **Lifecycle**: `Initialize` and `Terminate` are each called exactly once. Terminate runs on `pagehide`, `beforeunload` or `unload`, and data is committed when the tab is hidden, which covers mobile.
- **Status**: never downgraded. Passed stays passed, completed stays completed, and failed is set only when no attempts remain. Nothing is written in review mode.
- **Interactions**: written in order with `id` first, using version-specific formats (`a,c` / `wrong` / `HH:MM:SS` in 1.2; `a[,]c` / `incorrect` / ISO timestamp in 2004).
- **Data limits**: suspend data stays under 4,000 characters, the smallest limit any LMS guarantees. Finished sections are stored as one character, and video-watch bitmaps share a fixed budget.
- **Session time**: `HH:MM:SS.SS` for 1.2 and ISO 8601 (`PT#H#M#S`) for 2004.
- **Media**: MP4s are remuxed with the moov atom at the front so they stream immediately. Non-H.264 or non-AAC video is re-encoded to H.264/AAC so it plays in every browser.
- **Self-contained**: nothing loads from the internet. The player is plain ES5 and PDF.js is the legacy UMD build, so no `.mjs` MIME-type problems on LMS servers.

## Limitations

- PPTX animations, transitions and embedded audio or video are not kept, because slides are rendered to PDF. The same applies to DOCX features that don't exist in PDF.
- Quiz question types are single choice, multiple response and true/false. Images in questions aren't supported yet.
- Jobs are held in memory, so restarting the server clears unfinished and finished jobs.
- Some LMSs cap upload size at their end. Check your LMS limits for large video packages.

## Tests

```bash
npm test
```

- `test/e2e.test.js`: builds single-file, multi-file and quiz courses in every SCORM version. Checks zip layout (including a Java-style streaming read), manifest references, XSD validity (with `xmllint`), faststart MP4s, obfuscated answer keys, input validation, and that no external URLs are loaded.
- `test/runtime.test.js`: status rules in the SCORM runtime (no downgrades, when failed is set, completion vs success in 2004, interaction formats, review mode).
- `test/player.test.js`: boots a real packaged course in jsdom against a mock LMS and takes quizzes like a learner. Checks sequencing, combined scoring, attempts, relaunch and resume, and the fail path.

## Licences

PDF.js is Apache-2.0 (`vendor/pdfjs/LICENSE`). The ADL SCORM schema files are redistributed under the ADL terms, taken from the MIT-licensed `simple-scorm-packager`.
