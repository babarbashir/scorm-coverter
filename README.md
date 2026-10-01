# SCORM Converter

Convert **MP4, PDF, PPTX and DOCX** files (up to 500 MB) into **SCORM 1.2**, **SCORM 2004 3rd Edition** or **SCORM 2004 4th Edition** packages you can upload to any LMS.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, drop in a file, choose the SCORM version and click **Convert**. When it finishes you can download the `.zip` or open it in the built-in **LMS simulator**, which shows every SCORM call and lets you test resume.

### Requirements

| Tool | Needed for | Notes |
|---|---|---|
| Node.js 18+ | everything | |
| LibreOffice | DOCX / PPTX | Found automatically on macOS, Linux and Windows. Set `SOFFICE_PATH` to override. |
| ffmpeg | MP4 optimisation | Installed automatically through the `ffmpeg-static` npm package. Set `FFMPEG_PATH` to use your own. |

Environment variables: `PORT` (default 3000), `HOST` (default `127.0.0.1`; use `0.0.0.0` to expose it on your network), `DATA_DIR`, `JOB_TTL_HOURS` (default 6, how long finished packages are kept).

## What's in a package

```
imsmanifest.xml          single organization, single SCO, launches index.html
*.xsd / *.dtd            official ADL schema files for the chosen version
index.html               player
player/                  scorm-api.js, player.js, player.css, config.js
player/pdfjs/            bundled PDF.js (documents only)
content/document.pdf     or content/video.mp4 + poster.jpg
```

## LMS compatibility

- **ZIP format**: every entry stores its CRC and sizes in its local header, with no data descriptors. Java-based LMSs such as SAP SuccessFactors (Plateau) read packages with `ZipInputStream`, which rejects uncompressed entries that use descriptors (`only DEFLATED entries can have EXT descriptor`). The test suite reads every package the same way.
- **Manifest**: validated against the ADL XSDs for every version in the test suite. `imsmanifest.xml` sits at the zip root and every file is listed.
- **API discovery**: searches parent frames and then `window.opener`, and tolerates cross-origin frames, so it works with both frame-based and popup launches.
- **Lifecycle**: `Initialize` and `Terminate` are each called exactly once. Terminate runs on `pagehide`, `beforeunload` or `unload`, and data is committed when the tab is hidden, which covers mobile.
- **Data limits**: suspend data stays under 4,000 characters, the smallest limit any LMS guarantees, using a compact hex bitmap. Locations respect the 255 and 1,000 character limits.
- **Status**: starts as `incomplete` and moves to `completed`, optionally with `passed` and a 100% score. It is never downgraded on relaunch, and nothing is written in review mode.
- **Session time**: `HH:MM:SS.SS` for 1.2 and ISO 8601 (`PT#H#M#S`) for 2004.
- **Media**: MP4s are remuxed with the moov atom at the front so they stream immediately. Non-H.264 or non-AAC video is re-encoded to H.264/AAC so it plays in every browser.
- **Self-contained**: nothing loads from the internet. The player is plain ES5 and PDF.js is the legacy UMD build, so no `.mjs` MIME-type problems on LMS servers.

### Tracking options

| Option | Effect |
|---|---|
| Completion % | Share of pages viewed, or share of the video actually watched (seeking doesn't count), needed to complete. |
| On launch | Marks complete as soon as the learner opens it. |
| Report passed | Also sets `passed`: `lesson_status` in 1.2, `success_status` in 2004. |
| Report score | Sets a score of 100 (and scaled 1 in 2004) on completion. |
| Stop skipping ahead | Video only. Learners can't seek beyond the furthest point they have watched. |

## Limitations

- PPTX animations, transitions and embedded audio or video are not kept, because slides are rendered to PDF. The same applies to DOCX features that don't exist in PDF.
- Jobs are held in memory, so restarting the server clears unfinished and finished jobs.
- Some LMSs cap upload size at their end. Check your LMS limits for large video packages.

## Tests

```bash
npm test
```

Converts every fixture into every SCORM version, then checks the zip layout, manifest references, schema validity (with `xmllint`), faststart MP4s, and that no external URLs are loaded.

## Licences

PDF.js is Apache-2.0 (`vendor/pdfjs/LICENSE`). The ADL SCORM schema files are redistributed under the ADL terms, taken from the MIT-licensed `simple-scorm-packager`.
