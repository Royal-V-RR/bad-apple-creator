// Incremental video decoding and construction of the visual tile library.
import { FeatureSet, WORDS, pixelDist } from '../matching/features.js';

/** Pick sample times so that long recordings are covered evenly without exceeding the frame budget. */
export function planSampleTimes(duration, sampleFps, maxFrames) {
  const interval = Math.max(1 / sampleFps, duration / maxFrames);
  const times = [];
  for (let t = Math.min(0.05, duration / 2); t < duration - 0.01 && times.length < maxFrames; t += interval) times.push(+t.toFixed(4));
  if (!times.length) times.push(0);
  return times;
}

export function estimateWorkload(duration, preset) {
  const frames = planSampleTimes(duration, preset.sampleFps, preset.maxFrames).length;
  const outSeconds = Math.min(219.07, preset.maxOutput ?? 219.07);
  const memLibraryMB = (frames * preset.workW * preset.workH * 2) / 1e6;
  const memAudioMB = (outSeconds * preset.audioRate * 4) / 1e6;
  return { frames, memoryMB: Math.round(memLibraryMB + memAudioMB + 40), outFrames: Math.round(outSeconds * preset.outFps) };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function loadVideoElement(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(Object.assign(new Error('This browser cannot decode that video.'), { code: 'decode' }));
    v.src = url;
  });
}

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); resolve(); };
    const fail = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); reject(new Error('Seek failed')); };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = t;
  });
}

/**
 * Decode frames one at a time, crop to the 4:3 reference aspect, shrink immediately and keep only 8 bit grey.
 * No full resolution frame is retained.
 */
export async function extractFrames(video, { workW, workH, times, onProgress, signal }) {
  const canvas = makeCanvas(workW, workH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const vw = video.videoWidth, vh = video.videoHeight;
  const target = workW / workH;
  let sw = vw, sh = vh;
  if (vw / vh > target) sw = vh * target; else sh = vw / target;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await seekTo(video, times[i]);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, workW, workH);
    const rgba = ctx.getImageData(0, 0, workW, workH).data;
    const g = new Uint8Array(workW * workH);
    for (let p = 0, q = 0; p < g.length; p++, q += 4) g[p] = (rgba[q] * 77 + rgba[q + 1] * 151 + rgba[q + 2] * 28) >> 8;
    frames.push(g);
    onProgress?.((i + 1) / times.length);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  return frames;
}

// ----- Thresholding ----------------------------------------------------------------------------------------

export function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

export function adjustContrast(v, contrast) {
  const x = (v - 128) * contrast + 128;
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/** Global threshold: one cut for the whole recording, so brightness changes between frames are preserved. */
export function binarizeGlobal(gray, w, h, threshold, contrast, invert, out = new Uint8Array(w * h)) {
  for (let i = 0; i < out.length; i++) {
    const on = adjustContrast(gray[i], contrast) > threshold ? 1 : 0;
    out[i] = invert ? 1 - on : on;
  }
  return out;
}

/** Adaptive threshold from a box mean (integral image). Better for uneven lighting, costs more. */
export function binarizeAdaptive(gray, w, h, offset, contrast, invert, out = new Uint8Array(w * h)) {
  const r = Math.max(2, Math.round(Math.min(w, h) / 8));
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / area;
      const on = adjustContrast(gray[y * w + x], contrast) > mean + offset ? 1 : 0;
      out[y * w + x] = invert ? 1 - on : on;
    }
  }
  return out;
}

/**
 * Turn raw grey frames into the tile library: binary silhouettes, descriptors, and near duplicate removal.
 * Frames kept keep their original capture time so that temporal neighbours stay recognisable.
 */
export function buildLibrary(frames, times, { w, h, threshold = 0, adaptive = false, contrast = 1, invert = false, dedupe = 0.02 }) {
  const hist = new Float64Array(256);
  for (const f of frames) for (let i = 0; i < f.length; i += 3) hist[adjustContrast(f[i], contrast) | 0]++;
  const total = hist.reduce((a, b) => a + b, 0);
  const cut = otsu(hist, total) + threshold;
  const scratch = new Uint8Array(w * h);
  const all = new FeatureSet(frames.length);
  const binAll = [];
  for (let i = 0; i < frames.length; i++) {
    const bin = adaptive ? binarizeAdaptive(frames[i], w, h, threshold * 0.25, contrast, invert, new Uint8Array(w * h))
      : binarizeGlobal(frames[i], w, h, cut, contrast, invert, scratch);
    all.setFromBinary(i, bin, w, h);
    binAll.push(adaptive ? bin : null);
  }
  // Near duplicate removal against the last kept frame.
  const keep = [0];
  for (let i = 1; i < frames.length; i++) {
    const last = keep[keep.length - 1];
    if (pixelDist(all, i, all, last) >= dedupe) keep.push(i);
  }
  const features = new FeatureSet(keep.length);
  const gray = new Uint8Array(keep.length * w * h);
  const libTimes = new Float32Array(keep.length);
  keep.forEach((src, k) => {
    features.copyFrom(k, all, src);
    gray.set(frames[src], k * w * h);
    libTimes[k] = times[src];
  });
  return { count: keep.length, w, h, features, gray, times: libTimes, threshold: cut, removed: frames.length - keep.length };
}

/** Tone normalisation levels used by the compositor so that frame to frame brightness changes do not flicker. */
export function libraryLevels(lib) {
  const hist = new Float64Array(256);
  for (let i = 0; i < lib.gray.length; i += 2) hist[lib.gray[i]]++;
  const total = hist.reduce((a, b) => a + b, 0);
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
  if (hi - lo < 16) { lo = Math.max(0, lo - 8); hi = Math.min(255, hi + 8); }
  return { lo, hi };
}

export { WORDS };
