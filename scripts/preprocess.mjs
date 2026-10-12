#!/usr/bin/env node
// Offline preprocessing: converts the reference video into compact, chunked, content hashed assets.
// Development tool only. The deployed website never runs this. Requires ffmpeg and ffprobe on PATH.
//
//   node scripts/preprocess.mjs badapple.mp4 public/reference
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { REF } from '../src/lib/config.js';
import { packBits } from '../src/lib/bits.js';
import { fft, hann, hzToMidi, midiToHz } from '../src/lib/fft.js';

const [src = 'badapple.mp4', outDir = 'public/reference'] = process.argv.slice(2);
const CHUNK_FRAMES = 300;
const THRESHOLD = 128;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (/^(masks|audio-events|manifest)/.test(f)) unlinkSync(join(outDir, f));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr?.toString().slice(-600)}`);
  return r.stdout;
}

// 1. Stream info and frame timestamps
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'json', src]).toString()).streams[0];
const [fn, fd] = probe.r_frame_rate.split('/').map(Number);
const fps = fn / fd;
const ptsOut = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time',
  '-of', 'csv=p=0', src], { maxBuffer: 1 << 28 }).toString().trim().split('\n').map((l) => parseFloat(l.split(',')[0])).filter((v) => Number.isFinite(v));
let maxDrift = 0;
for (let i = 0; i < ptsOut.length; i++) maxDrift = Math.max(maxDrift, Math.abs(ptsOut[i] - (ptsOut[0] + i / fps)));
const uniform = maxDrift < 0.002;
console.log(`video ${probe.width}x${probe.height} @ ${fps}fps, ${ptsOut.length} frames, uniform timestamps: ${uniform} (max drift ${maxDrift.toFixed(5)}s)`);

// 2. Monochrome masks
const raw = join(tmpdir(), `ba-${process.pid}.gray`);
run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-vf', `scale=${REF.maskW}:${REF.maskH}:flags=area`,
  '-pix_fmt', 'gray', '-f', 'rawvideo', raw]);
const gray = readFileSync(raw);
rmSync(raw);
const px = REF.maskW * REF.maskH;
const frames = Math.floor(gray.length / px);
const bytesPerFrame = px >> 3;
const chunks = [];
let totalGz = 0;
for (let start = 0, ci = 0; start < frames; start += CHUNK_FRAMES, ci++) {
  const count = Math.min(CHUNK_FRAMES, frames - start);
  const buf = new Uint8Array(count * bytesPerFrame);
  let prev = null;
  for (let f = 0; f < count; f++) {
    const bin = new Uint8Array(px);
    const o = (start + f) * px;
    for (let i = 0; i < px; i++) bin[i] = gray[o + i] >= THRESHOLD ? 1 : 0;
    const packed = packBits(bin);
    for (let i = 0; i < bytesPerFrame; i++) buf[f * bytesPerFrame + i] = prev ? packed[i] ^ prev[i] : packed[i];
    prev = packed;
  }
  const gz = gzipSync(buf, { level: 9 });
  const hash = sha(gz).slice(0, 10);
  const file = `masks-${String(ci).padStart(3, '0')}.${hash}.bin.gz`;
  writeFileSync(join(outDir, file), gz);
  chunks.push({ file, start, count, bytes: gz.length, sha256: sha(gz) });
  totalGz += gz.length;
}
console.log(`masks: ${frames} frames in ${chunks.length} chunks, ${(totalGz / 1024).toFixed(0)} KiB gzipped`);

// 3. Audio analysis: onset times and an approximate melody line
const SR = 22050;
const audioRaw = run('ffmpeg', ['-v', 'error', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
const pcm = new Float32Array(audioRaw.buffer, audioRaw.byteOffset, audioRaw.byteLength >> 2);
const N = 4096, HOP = 441, bins = N / 2;
const win = hann(N);
const nFrames = Math.floor((pcm.length - N) / HOP);
const re = new Float32Array(N), im = new Float32Array(N);
const mag = new Float32Array(bins);
const prevMag = new Float32Array(bins);
const binHz = SR / N;
const flux = new Float32Array(nFrames), rms = new Float32Array(nFrames), cent = new Float32Array(nFrames);
const midiTrack = new Float32Array(nFrames), sal = new Float32Array(nFrames);
const MIDI_LO = 55, MIDI_HI = 93;
const hw = [1, 0.84, 0.7, 0.59, 0.5, 0.42];

for (let f = 0; f < nFrames; f++) {
  const s = f * HOP;
  let e = 0;
  for (let i = 0; i < N; i++) { const v = pcm[s + i] * win[i]; re[i] = v; im[i] = 0; e += v * v; }
  rms[f] = Math.sqrt(e / N);
  fft(re, im);
  let fl = 0, c = 0, m = 0;
  for (let k = 0; k < bins; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    const lg = Math.log1p(mag[k] * 20);
    const d = lg - prevMag[k];
    if (d > 0) fl += d;
    prevMag[k] = lg;
    c += k * binHz * mag[k]; m += mag[k];
  }
  flux[f] = fl;
  cent[f] = m > 0 ? c / m : 0;
  let best = 0, bestM = 0;
  for (let mi = MIDI_LO; mi <= MIDI_HI; mi++) {
    const f0 = midiToHz(mi);
    let sc = 0;
    for (let h = 1; h <= hw.length; h++) {
      const kk = (f0 * h) / binHz;
      if (kk >= bins - 2) break;
      const k0 = Math.round(kk);
      sc += hw[h - 1] * Math.max(mag[k0 - 1], mag[k0], mag[k0 + 1]);
    }
    if (sc > best) { best = sc; bestM = mi; }
  }
  sal[f] = best; midiTrack[f] = bestM;
}

// Onsets: adaptive threshold on flux with a minimum spacing
const onsets = [];
const w = 25;
let lastOn = -1e9;
for (let f = 2; f < nFrames - 2; f++) {
  let sum = 0, cnt = 0;
  for (let j = Math.max(0, f - w); j < Math.min(nFrames, f + w); j++) { sum += flux[j]; cnt++; }
  const thr = (sum / cnt) * 1.5 + 0.5;
  if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && flux[f] >= flux[f - 2] && flux[f] >= flux[f + 2]) {
    const t = (f * HOP + N / 2) / SR;
    if (t - lastOn >= 0.07) {
      onsets.push([+t.toFixed(3), +Math.min(1, flux[f] / (thr * 3)).toFixed(3), Math.round(cent[f])]);
      lastOn = t;
    }
  }
}

// Melody: median filter pitch, then segment into notes
const med = new Float32Array(nFrames);
for (let f = 0; f < nFrames; f++) {
  const win5 = [];
  for (let j = -3; j <= 3; j++) win5.push(midiTrack[Math.min(nFrames - 1, Math.max(0, f + j))]);
  win5.sort((a, b) => a - b);
  med[f] = win5[3];
}
const sortedSal = Array.from(sal).sort((a, b) => a - b);
const salFloor = sortedSal[Math.floor(sortedSal.length * 0.2)];
const rmsSorted = Array.from(rms).sort((a, b) => a - b);
const rmsFloor = rmsSorted[Math.floor(rmsSorted.length * 0.2)];
const rmsMax = rmsSorted[Math.floor(rmsSorted.length * 0.98)] || 1;
const notes = [];
let cur = null;
const flush = () => {
  if (cur && cur.len >= 3) {
    const t0 = (cur.start * HOP + N / 2) / SR;
    notes.push([+t0.toFixed(3), +((cur.len * HOP) / SR).toFixed(3), cur.midi, +Math.min(1, cur.vel / cur.len / rmsMax).toFixed(3)]);
  }
  cur = null;
};
for (let f = 0; f < nFrames; f++) {
  const voiced = sal[f] > salFloor && rms[f] > rmsFloor;
  if (!voiced) { flush(); continue; }
  if (cur && Math.abs(med[f] - cur.midi) <= 1) { cur.len++; cur.vel += rms[f]; }
  else { flush(); cur = { start: f, len: 1, midi: med[f], vel: rms[f] }; }
}
flush();

// Tempo estimate from onset inter-onset intervals
const hist = new Map();
for (let i = 1; i < onsets.length; i++) {
  const ioi = onsets[i][0] - onsets[i - 1][0];
  if (ioi > 0.15 && ioi < 1.2) { const k = Math.round(60 / ioi); hist.set(k, (hist.get(k) || 0) + 1); }
}
let bpm = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
while (bpm > 180) bpm = Math.round(bpm / 2);
while (bpm > 0 && bpm < 70) bpm *= 2;
const duration = pcm.length / SR;
const events = { version: 1, duration: +duration.toFixed(3), bpmEstimate: bpm, onsets, notes };
const evBuf = Buffer.from(JSON.stringify(events));
const evFile = `audio-events.${sha(evBuf).slice(0, 10)}.json`;
writeFileSync(join(outDir, evFile), evBuf);
console.log(`audio: ${onsets.length} onsets, ${notes.length} notes, bpm~${bpm}, ${(evBuf.length / 1024).toFixed(0)} KiB`);

// 4. Manifest
const manifest = {
  version: 1,
  source: { file: basename(src), sha256: sha(readFileSync(src)), bytes: statSync(src).size, width: probe.width, height: probe.height },
  duration: +(frames / fps).toFixed(4),
  fps,
  frames,
  timestamps: uniform ? { uniform: true, start: +ptsOut[0].toFixed(5) } : { uniform: false, pts: ptsOut.map((v) => +v.toFixed(5)) },
  mask: { width: REF.maskW, height: REF.maskH, bytesPerFrame, threshold: THRESHOLD, delta: 'xor-previous-in-chunk', compression: 'gzip' },
  chunks,
  audioEvents: { file: evFile, sha256: sha(evBuf) },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('wrote manifest.json');
