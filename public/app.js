(function () {
  'use strict';

  const MAX_BYTES = 500 * 1024 * 1024;
  const KINDS = { mp4: 'mp4', m4v: 'mp4', pdf: 'pdf', pptx: 'pptx', docx: 'docx' };

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const fileInput = $('file');
  const drop = $('drop');
  const submit = $('submit');
  const titleInput = $('title');
  const threshold = $('threshold');

  let file = null;
  let kind = null;
  let caps = { office: true, ffmpeg: true, maxBytes: MAX_BYTES };
  let titleTouched = false;

  fetch('/api/capabilities').then((r) => r.json()).then((c) => { caps = c; }).catch(() => {});

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function setBadge(el, k) {
    el.textContent = (k || '?').toUpperCase();
    el.className = 'file-badge ' + (k || '');
  }

  function fileError(msg) { $('file-error').textContent = msg || ''; }

  function pick(f) {
    fileError('');
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const k = KINDS[ext];
    if (!k) return fileError('Unsupported file type. Choose an MP4, PDF, PPTX or DOCX file.');
    if (f.size > (caps.maxBytes || MAX_BYTES)) return fileError(`This file is ${fmtBytes(f.size)}. The limit is 500 MB.`);
    if (f.size === 0) return fileError('This file is empty.');
    if ((k === 'pptx' || k === 'docx') && caps.office === false) {
      return fileError('DOCX/PPTX conversion needs LibreOffice, which is not installed on the server.');
    }
    file = f;
    kind = k;
    drop.classList.add('has-file');
    drop.querySelector('.drop-empty').hidden = true;
    drop.querySelector('.drop-file').hidden = false;
    $('file-name').textContent = f.name;
    $('file-size').textContent = fmtBytes(f.size);
    setBadge($('file-badge'), k);
    if (!titleTouched) titleInput.value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

    const isVideo = k === 'mp4';
    $('progress-verb').textContent = isVideo ? 'watched' : 'viewed';
    $('progress-noun').textContent = isVideo ? 'video' : (k === 'pptx' ? 'slides' : 'pages');
    threshold.value = isVideo ? 95 : 100;
    document.querySelectorAll('.video-only').forEach((el) => { el.hidden = !isVideo; });
    submit.disabled = false;
  }

  fileInput.addEventListener('change', () => pick(fileInput.files[0]));
  $('file-clear').addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
  titleInput.addEventListener('input', () => { titleTouched = true; });

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) pick(e.dataTransfer.files[0]); });
  // Avoid the browser navigating away when a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  threshold.addEventListener('change', () => {
    const v = Math.max(1, Math.min(100, parseInt(threshold.value, 10) || 100));
    threshold.value = v;
  });
  threshold.addEventListener('focus', () => { form.querySelector('input[name=completion][value=progress]').checked = true; });

  // ------------------------------------------------------------------
  // Progress UI
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

  function reset() {
    $('progress-card').hidden = true;
    $('form-card').hidden = false;
    $('done').hidden = true;
    $('retry-row').hidden = true;
    $('job-error').textContent = '';
    bar.classList.remove('error', 'done');
    progress(0, '');
    submit.disabled = !file;
  }
  $('again').addEventListener('click', () => {
    file = null; kind = null; titleTouched = false; fileInput.value = ''; titleInput.value = '';
    drop.classList.remove('has-file');
    drop.querySelector('.drop-empty').hidden = false;
    drop.querySelector('.drop-file').hidden = true;
    reset();
  });
  $('retry').addEventListener('click', reset);

  // ------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!file) return;

    const fd = new FormData();
    const version = form.querySelector('input[name=version]:checked').value;
    fd.append('title', titleInput.value.trim());
    fd.append('version', version);
    fd.append('completion', form.querySelector('input[name=completion]:checked').value);
    fd.append('threshold', threshold.value);
    fd.append('passOnComplete', String(form.passOnComplete.checked));
    fd.append('reportScore', String(form.reportScore.checked));
    fd.append('restrictSeek', String(kind === 'mp4' && form.restrictSeek.checked));
    fd.append('file', file); // fields first so the server has them when the file arrives

    $('form-card').hidden = true;
    $('progress-card').hidden = false;
    $('job-title').textContent = titleInput.value.trim() || file.name;
    $('job-sub').textContent = `${file.name} · ${fmtBytes(file.size)} · ${form.querySelector('input[name=version]:checked + span').textContent}`;
    setBadge($('job-badge'), kind);
    progress(0, 'Uploading…');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert');
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
    const w = $('warnings');
    w.innerHTML = '';
    (job.warnings || []).forEach((t) => { const li = document.createElement('li'); li.textContent = t; w.appendChild(li); });
    $('download').focus();
  }
})();
