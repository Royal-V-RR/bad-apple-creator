import { PRESETS, DEFAULT_SETTINGS, defaultPresetName } from './lib/config.js';
import { Session, STAGES, estimate } from './pipeline.js';
import { CameraRecorder, cameraSupport, InputError, LIMITS } from './media/input.js';
import { exportVideo, ExportError, saveBlob, shareBlob, probeExport } from './export/exporter.js';
import { Preview } from './ui/preview.js';
import { startHero } from './ui/hero.js';
import { cacheClear } from './storage/cache.js';

const $ = (id) => document.getElementById(id);
const settings = { ...DEFAULT_SETTINGS, preset: defaultPresetName() };
let session = null, result = null, preview = null, abort = null, recorder = null, stopHero = null, exportBlob = null, exportName = 'bad-apple-reconstruction';

// ---------- views ----------
function show(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  $('main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
  if (name !== 'landing' && stopHero) { stopHero(); stopHero = null; }
}
function showError(id, err) {
  const el = $(id);
  el.textContent = typeof err === 'string' ? err : err.message;
  el.hidden = false;
}
const clearError = (id) => { $(id).hidden = true; };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- landing ----------
async function boot() {
  $('btn-choose').onclick = () => $('file').click();
  $('file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleFile(f); };
  $('btn-record').onclick = openRecorder;
  $('btn-info').onclick = () => $('info').showModal();
  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  addEventListener('dragleave', () => document.body.classList.remove('dropping'));
  addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dropping'); const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); });
  buildSetupForm();
  stopHero = await startHero($('hero')).catch(() => null);
}

async function handleFile(file) {
  clearError('landing-error');
  disposeAll();
  const s = new Session(file);
  try {
    await s.open();
  } catch (err) {
    s.dispose();
    show('landing');
    showError('landing-error', err instanceof InputError ? err.message : `Could not open that video. ${err.message}`);
    return;
  }
  session = s;
  openSetup();
}

// ---------- recording ----------
async function openRecorder() {
  show('record');
  clearError('rec-error');
  const sup = cameraSupport();
  if (!sup.ok) showError('rec-error', sup.reason);
  setRecUi('idle');
}
function setRecUi(state) {
  const map = { 'rec-open': 'idle', 'rec-start': 'ready', 'rec-stop': 'recording', 'rec-retake': 'review', 'rec-use': 'review' };
  for (const [id, st] of Object.entries(map)) $(id).hidden = st !== state;
  $('rec-live').hidden = state === 'review';
  $('rec-review').hidden = state !== 'review';
}
$('rec-open').onclick = async () => {
  clearError('rec-error');
  recorder = new CameraRecorder();
  try {
    const stream = await recorder.open();
    $('rec-live').srcObject = stream; await $('rec-live').play();
    $('rec-status').textContent = 'Camera is on. Press Start recording, then make some noise.';
    setRecUi('ready');
  } catch (err) { showError('rec-error', err); recorder.close(); recorder = null; }
};
$('rec-start').onclick = () => {
  recorder.start((s, max) => { $('rec-timer').textContent = `${s.toFixed(1)} / ${max} s`; if (s >= max) finishRec(); });
  setRecUi('recording');
};
let recBlob = null;
async function finishRec() {
  if (!recorder) return;
  recBlob = await recorder.stop();
  recorder.close();
  $('rec-live').srcObject = null;
  $('rec-review').src = URL.createObjectURL(recBlob);
  $('rec-status').textContent = 'Check the clip. Retake it or use it.';
  setRecUi('review');
}
$('rec-stop').onclick = finishRec;
$('rec-retake').onclick = () => { URL.revokeObjectURL($('rec-review').src); recBlob = null; $('rec-open').click(); };
$('rec-use').onclick = () => {
  const ext = recBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([recBlob], `recording.${ext}`, { type: recBlob.type });
  URL.revokeObjectURL($('rec-review').src);
  handleFile(file);
};
$('rec-back').onclick = () => { recorder?.close(); recorder = null; show('landing'); };

// ---------- setup ----------
function buildSetupForm() {
  const list = $('preset-list');
  for (const [key, p] of Object.entries(PRESETS)) {
    const l = document.createElement('label');
    l.className = 'choice';
    l.innerHTML = `<input type="radio" name="preset" value="${key}"><span>${p.label}<small>${p.note} ${p.outW}x${p.outH} at ${p.outFps} fps.</small></span>`;
    list.appendChild(l);
  }
  list.addEventListener('change', (e) => { settings.preset = e.target.value; refreshEstimate(); });
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $(`s-${key}`);
    if (!el) continue;
    el.addEventListener('input', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' && key !== 'outputSeconds' ? el.value : el.type === 'range' || key === 'outputSeconds' ? Number(el.value) : el.value;
      const o = $(`o-${key}`); if (o) o.textContent = el.value;
      refreshEstimate();
    });
  }
  $('setup-form').onsubmit = (e) => { e.preventDefault(); runBuild(); };
  $('btn-other').onclick = () => { disposeAll(); show('landing'); };
}
function syncSetupForm() {
  for (const r of document.querySelectorAll('input[name=preset]')) r.checked = r.value === settings.preset;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $(`s-${key}`); if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = String(settings[key]);
    const o = $(`o-${key}`); if (o) o.textContent = el.value;
  }
}
function openSetup() {
  const m = session.meta;
  $('src-preview').src = session.url;
  $('src-facts').textContent = `${m.width} by ${m.height}, ${m.duration.toFixed(1)} seconds, ${m.orientation}. Source frames are cropped to 4:3.`;
  syncSetupForm();
  clearError('setup-error');
  refreshEstimate();
  show('setup');
}
function refreshEstimate() {
  if (!session) return;
  const e = estimate(session.meta.duration, settings);
  const sec = settings.outputSeconds || 219;
  $('estimate').innerHTML = `<p>Uses about ${e.frames} of your frames. Builds ${e.outFrames.toLocaleString()} output frames. Memory in use around ${e.memoryMB} MB.</p>` + e.warnings.map((w) => `<p>Heads up: ${w}</p>`).join('');
  $('btn-start').textContent = sec > 90 && settings.preset !== 'fast' ? 'Make it (this may take a few minutes)' : 'Make it';
}

// ---------- processing ----------
function buildStageList() {
  const ol = $('stages'); ol.innerHTML = '';
  for (const s of STAGES) {
    const li = document.createElement('li');
    li.className = 'stage'; li.id = `st-${s.id}`; li.dataset.state = 'pending';
    li.innerHTML = `<span class="mk" aria-hidden="true"></span><div><div class="st">${s.label}: <span class="state">waiting</span></div><div class="dt"></div><progress max="1" value="0" hidden></progress></div>`;
    ol.appendChild(li);
  }
}
const STATE_TEXT = { pending: 'waiting', active: 'working', done: 'done', skipped: 'skipped', error: 'failed' };
function report(id, { state, fraction = 0, detail = '' }) {
  const li = $(`st-${id}`); if (!li) return;
  const changed = li.dataset.state !== state;
  li.dataset.state = state;
  li.querySelector('.state').textContent = STATE_TEXT[state];
  if (detail || state !== 'active') li.querySelector('.dt').textContent = detail;
  else if (state === 'active' && detail === '') li.querySelector('.dt').textContent = '';
  const p = li.querySelector('progress');
  p.hidden = state !== 'active'; p.value = fraction;
  if (changed) $('live').textContent = `${STAGES.find((s) => s.id === id).label}: ${STATE_TEXT[state]}. ${detail}`;
}

async function runBuild() {
  clearError('setup-error'); clearError('process-error');
  buildStageList();
  report('read', { state: 'done', fraction: 1, detail: `${session.meta.width}x${session.meta.height}, ${session.meta.duration.toFixed(1)} s` });
  preview?.destroy(); preview = null; result = null; exportBlob = null;
  show('process');
  abort = new AbortController();
  try {
    result = await session.build(settings, { report, signal: abort.signal });
  } catch (err) {
    const active = document.querySelector('.stage[data-state=active]');
    if (active) active.dataset.state = err.name === 'AbortError' ? 'pending' : 'error';
    if (err.name === 'AbortError') { openSetup(); return; }
    showError('process-error', `${err.message || err} You can go back and choose Fast, a shorter length, or a different video.`);
    $('btn-cancel').textContent = 'Back to settings';
    $('btn-cancel').onclick = () => { $('btn-cancel').textContent = 'Cancel'; $('btn-cancel').onclick = cancel; openSetup(); };
    return;
  }
  showResult();
  encode();
}
function cancel() { abort?.abort(); }
$('btn-cancel').onclick = cancel;

// ---------- result ----------
function showResult() {
  show('result');
  preview = new Preview({ canvas: $('out'), result, onTime: updateTransport, onEnd: () => { $('t-play').textContent = 'Play'; } });
  updateTransport(0);
  const p = result.preset, st = result.stats;
  const rows = [['Output', `${result.width} by ${result.height} at ${p.outFps} fps, ${result.timeline.seconds.toFixed(0)} s`],
    ['Your frames', `${st.libraryFrames} tiles from ${st.sourceFrames} frames, ${st.duplicatesRemoved} duplicates removed`],
    ['Tile reuse', `${st.visual.distinctUsed} tiles cover ${st.visual.frames} frames, ${st.visual.switches} switches`],
    ['Sounds', result.audio ? `${st.audio.distinctUsed} of ${st.sounds} sounds used across ${st.audio.events} events` : 'No audio in this result'],
    ['Time taken', `${(result.timings.total / 1000).toFixed(1)} s`]];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const fpsSel = $('x-fps'); fpsSel.innerHTML = [p.outFps, Math.round(p.outFps / 2), 10].filter((v, i, a) => a.indexOf(v) === i).map((v) => `<option value="${v}">${v} fps</option>`).join('');
  const secs = $('x-secs'); secs.innerHTML = [result.timeline.seconds, 60, 30, 15].filter((v, i, a) => v <= result.timeline.seconds && a.indexOf(v) === i).map((v) => `<option value="${v}">${Math.round(v)} s</option>`).join('');
  $('btn-compare').setAttribute('aria-pressed', 'false'); $('ref-wrap').hidden = true;
}
function updateTransport(t) {
  const d = result.timeline.seconds;
  $('t-time').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  if (document.activeElement !== $('t-seek')) $('t-seek').value = String(Math.round((t / d) * 1000));
  if (refVideo()) syncRef(t);
}
$('t-play').onclick = async () => {
  if (!preview) return;
  if (preview.playing) { preview.pause(); $('t-play').textContent = 'Play'; refVideo()?.pause(); }
  else { await preview.play(); $('t-play').textContent = 'Pause'; refVideo()?.play().catch(() => {}); }
};
$('t-seek').oninput = (e) => preview?.seek((Number(e.target.value) / 1000) * result.timeline.seconds);

const refVideo = () => ($('ref-wrap').hidden ? null : $('ref-video'));
function syncRef(t) { const v = $('ref-video'); if (Math.abs(v.currentTime - t) > 0.25) v.currentTime = t; }
$('btn-compare').onclick = () => {
  const on = $('ref-wrap').hidden;
  $('ref-wrap').hidden = !on;
  $('btn-compare').setAttribute('aria-pressed', String(on));
  if (on) {
    const v = $('ref-video');
    if (!v.src) { v.preload = 'auto'; v.src = new URL('reference/badapple.mp4', document.baseURI).href; }
    v.currentTime = preview.time;
    if (preview.playing) v.play().catch(() => {});
  } else $('ref-video').pause();
};

// ---------- encoding ----------
async function encode(opts = {}) {
  if (!result) return;
  preview?.pause(); $('t-play').textContent = 'Play';
  clearError('enc-error'); $('retry').hidden = true;
  $('btn-download').disabled = true; $('btn-share').hidden = true;
  const li = $('enc-progress'); li.value = 0;
  $('enc-status').textContent = 'Encoding the final video on this device.';
  abort = new AbortController();
  try {
    const plan = result.makePlan(opts);
    const out = await exportVideo({ timeline: plan.timeline, renderFrame: plan.renderFrame, audio: plan.audio, width: plan.width, height: plan.height, signal: abort.signal, onProgress: (v) => { li.value = v; $('enc-status').textContent = `Encoding: ${Math.round(v * 100)} percent`; } });
    exportBlob = out; exportName = `bad-apple-reconstruction.${out.ext}`;
    li.value = 1;
    $('enc-status').textContent = `Ready: ${(out.blob.size / 1048576).toFixed(1)} MB ${out.ext.toUpperCase()}, ${out.engine}${plan.audio ? ', with sound' : ', picture only'}.`;
    $('btn-download').disabled = false;
    if (navigator.canShare && navigator.canShare({ files: [new File([out.blob], exportName, { type: out.blob.type })] })) $('btn-share').hidden = false;
  } catch (err) {
    if (err.name === 'AbortError') { $('enc-status').textContent = 'Encoding cancelled.'; }
    else {
      $('enc-status').textContent = 'Encoding did not finish.';
      showError('enc-error', `${err.message}${err instanceof ExportError && err.hint ? ' ' + err.hint : ' Lower the size, frame rate, or length and try again.'}`);
    }
    $('retry').hidden = false;
  }
}
$('btn-reencode').onclick = () => encode({ scale: Number($('x-scale').value), fps: Number($('x-fps').value), secs: Number($('x-secs').value) });
$('btn-download').onclick = () => { try { saveBlob(exportBlob.blob, exportName); } catch (e) { showError('enc-error', `The download failed. ${e.message}. Try Share or save instead.`); } };
$('btn-share').onclick = () => shareBlob(exportBlob.blob, exportName).catch((e) => e.name !== 'AbortError' && showError('enc-error', e.message));
$('btn-tweak').onclick = () => { abort?.abort(); preview?.destroy(); preview = null; openSetup(); };
$('btn-restart').onclick = () => { disposeAll(); show('landing'); startHero($('hero')).then((s) => { stopHero = s; }); };
$('btn-clear').onclick = async () => { disposeAll(); await cacheClear(); show('landing'); };

function disposeAll() {
  abort?.abort();
  preview?.destroy(); preview = null;
  result = null; exportBlob = null;
  session?.dispose(); session = null;
  recorder?.close(); recorder = null;
  $('src-preview').removeAttribute('src');
  const v = $('ref-video'); v.pause(); v.removeAttribute('src'); v.load();
}

boot();
