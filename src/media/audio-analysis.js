// Audio decoding helpers, segmentation into reusable samples, and per sample features.
import { fft, hann, hzToMidi } from '../lib/fft.js';

export async function decodeAudio(arrayBuffer) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) throw Object.assign(new Error('Web Audio is not available in this browser.'), { code: 'audio-unsupported' });
  const ctx = new AC();
  try {
    const buf = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arrayBuffer, res, rej);
      p?.then?.(res, rej);
    });
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
    }
    return { mono, sampleRate: buf.sampleRate };
  } finally {
    ctx.close?.();
  }
}

export function hasUsableAudio(mono) {
  if (!mono || mono.length < 1000) return false;
  let peak = 0, e = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; e += mono[i] * mono[i]; }
  return peak > 0.003 && Math.sqrt(e / mono.length) > 0.0003;
}

export function resampleLinear(x, srcRate, dstRate) {
  if (srcRate === dstRate) return x.slice();
  const ratio = srcRate / dstRate;
  let src = x;
  if (ratio > 1.5) {                       // crude anti alias: box average before decimating
    const k = Math.round(ratio);
    src = new Float32Array(Math.floor(x.length / k));
    for (let i = 0; i < src.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += x[i * k + j]; src[i] = s / k; }
    srcRate = srcRate / k;
  }
  const r = srcRate / dstRate;
  const out = new Float32Array(Math.max(1, Math.floor(src.length / r)));
  for (let i = 0; i < out.length; i++) {
    const p = i * r, i0 = Math.floor(p), f = p - i0;
    out[i] = src[i0] * (1 - f) + (src[Math.min(src.length - 1, i0 + 1)] ?? 0) * f;
  }
  return out;
}

const dbOf = (v) => 20 * Math.log10(v + 1e-9);
const pct = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

/**
 * Split a recording into sounds using an energy envelope with hysteresis, onset splitting,
 * minimum and maximum durations. Returns [{ start, end }] in sample indices.
 */
export function segmentAudio(x, sr, { minDur = 0.04, maxDur = 1.2, maxSamples = 160 } = {}) {
  const hop = Math.max(1, Math.round(sr * 0.01));
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = i * hop, b = Math.min(x.length, a + hop * 2);
    for (let j = a; j < b; j++) s += x[j] * x[j];
    env[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  const envDb = env.map(dbOf);
  const floor = pct(envDb, 0.1), peak = pct(envDb, 0.999);
  const segs = [];
  if (peak - floor >= 6) {
    const on = Math.max(floor + 9, peak - 45), off = on - 3;
    let start = -1, quiet = 0;
    for (let i = 0; i < n; i++) {
      if (start < 0) { if (envDb[i] > on) { start = i; quiet = 0; } }
      else if (envDb[i] < off) { if (++quiet >= 4) { segs.push([start, i - quiet + 1]); start = -1; } }
      else quiet = 0;
    }
    if (start >= 0) segs.push([start, n]);
  }
  const split = [];
  const maxF = Math.round(maxDur / 0.01), minF = Math.round(minDur / 0.01);
  for (const [a0, b0] of segs) {
    let a = a0;
    const cuts = [];
    for (let i = a0 + 8; i < b0 - 2; i++) {            // transient detection inside a segment
      let m = 0;
      for (let k = 1; k <= 4; k++) m += env[i - k];
      m /= 4;
      if (env[i] > 3 * m + 1e-4 && env[i] >= env[i - 1] && i - (cuts[cuts.length - 1] ?? a0) > 8) cuts.push(i - 1);
    }
    cuts.push(b0);
    for (const c of cuts) {
      let s = a;
      while (c - s > maxF) {                           // split long sounds at their quietest point
        let best = s + Math.round(maxF * 0.4), bv = Infinity;
        for (let i = s + Math.round(maxF * 0.4); i < s + maxF; i++) if (env[i] < bv) { bv = env[i]; best = i; }
        split.push([s, best]); s = best;
      }
      split.push([s, c]);
      a = c;
    }
  }
  let out = split.filter(([a, b]) => b - a >= minF).map(([a, b]) => ({
    start: Math.max(0, (a - 1) * hop),
    end: Math.min(x.length, (b + 3) * hop),
    score: Math.max(...env.subarray(a, b)) * Math.sqrt(b - a),
  }));
  if (out.length > maxSamples) out = out.sort((p, q) => q.score - p.score).slice(0, maxSamples).sort((p, q) => p.start - q.start);
  return out.map(({ start, end }) => ({ start, end }));
}

/** Evenly spaced fallback used only when a recording has sound but no usable events. */
export function fallbackSegments(x, sr, count = 24, len = 0.3) {
  const L = Math.round(len * sr), segs = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(((x.length - L) * i) / Math.max(1, count - 1));
    if (start >= 0 && start + L <= x.length) segs.push({ start, end: start + L });
  }
  return segs;
}

export function estimatePitch(x, sr) {
  const N = Math.min(x.length, 2048);
  if (N < 256) return { f0: 0, clarity: 0 };
  let best = 0, start = 0;
  for (let s = 0; s + N <= x.length; s += Math.max(256, N >> 1)) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[s + i] * x[s + i];
    if (e > best) { best = e; start = s; }
  }
  const lagMin = Math.floor(sr / 1000), lagMax = Math.min(N - 1, Math.floor(sr / 80));
  const acf = new Float32Array(lagMax + 2);
  let e0 = 0;
  for (let i = 0; i < N; i++) e0 += x[start + i] * x[start + i];
  if (e0 < 1e-9) return { f0: 0, clarity: 0 };
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0, e1 = 0;
    for (let i = 0; i + lag < N; i++) { s += x[start + i] * x[start + i + lag]; e1 += x[start + i + lag] * x[start + i + lag]; }
    acf[lag] = s / Math.sqrt(e0 * e1 + 1e-12);
  }
  let max = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) max = Math.max(max, acf[lag]);
  for (let lag = lagMin + 1; lag < lagMax; lag++) {    // first strong local maximum avoids octave errors downward
    if (acf[lag] > 0.9 * max && acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) return { f0: sr / lag, clarity: Math.max(0, acf[lag]) };
  }
  return { f0: 0, clarity: 0 };
}

export function spectralFeatures(x, sr) {
  const N = 1024;
  const win = hann(N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const spec = new Float32Array(N / 2);
  let loud = 0, ls = 0;
  const step = Math.max(256, N >> 1);
  for (let s = 0; s + 1 < x.length; s += step) {
    let e = 0;
    for (let i = 0; i < N && s + i < x.length; i++) e += x[s + i] * x[s + i];
    if (e > loud) { loud = e; ls = s; }
  }
  for (let w = -1; w <= 1; w++) {
    const s = Math.max(0, Math.min(Math.max(0, x.length - N), ls + w * step));
    for (let i = 0; i < N; i++) { re[i] = (s + i < x.length ? x[s + i] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) spec[k] += Math.hypot(re[k], im[k]);
  }
  const binHz = sr / N;
  let tot = 0, cs = 0, geo = 0;
  for (let k = 1; k < N / 2; k++) { tot += spec[k]; cs += spec[k] * k * binHz; geo += Math.log(spec[k] + 1e-9); }
  const centroid = tot > 0 ? cs / tot : 0;
  let acc = 0, rolloff = 0;
  for (let k = 1; k < N / 2; k++) { acc += spec[k]; if (acc >= 0.85 * tot) { rolloff = k * binHz; break; } }
  const flatness = tot > 0 ? Math.exp(geo / (N / 2 - 1)) / (tot / (N / 2 - 1)) : 0;
  const edges = [500, 2000, 6000, Infinity], bands = [0, 0, 0, 0];
  for (let k = 1; k < N / 2; k++) { let b = 0; while (k * binHz > edges[b]) b++; bands[b] += spec[k]; }
  const bt = bands.reduce((a, b) => a + b, 0) || 1;
  let zc = 0;
  for (let i = 1; i < x.length; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
  return { centroid, rolloff, flatness: Math.min(1, flatness), bands: bands.map((v) => v / bt), zcr: zc / Math.max(1, x.length) };
}

export function describeSample(pcm, sr) {
  let peak = 0, e = 0;
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; e += pcm[i] * pcm[i]; }
  const sp = spectralFeatures(pcm, sr);
  const { f0, clarity } = estimatePitch(pcm, sr);
  const pitched = clarity > 0.6 && f0 > 0;
  const baseMidi = pitched ? hzToMidi(f0) : Math.max(48, Math.min(84, hzToMidi(Math.max(80, sp.centroid))));
  return { duration: pcm.length / sr, rms: Math.sqrt(e / pcm.length), peak, ...sp, f0, clarity, pitched, baseMidi };
}

/** Full pipeline: segment, describe, normalise, fade edges and resample to the output rate. */
export function buildSampleLibrary(mono, sr, outRate, opts = {}) {
  let segs = segmentAudio(mono, sr, opts);
  let fallback = false;
  if (!segs.length && hasUsableAudio(mono)) { segs = fallbackSegments(mono, sr); fallback = true; }
  const samples = [];
  const fade = Math.round(sr * 0.004);
  for (const { start, end } of segs) {
    const raw = mono.slice(start, end);
    const feat = describeSample(raw, sr);
    if (feat.peak < 1e-4) continue;
    const g = 0.9 / feat.peak;
    for (let i = 0; i < raw.length; i++) {
      let w = 1;
      if (i < fade) w = i / fade; else if (raw.length - 1 - i < fade) w = (raw.length - 1 - i) / fade;
      raw[i] *= g * w;
    }
    samples.push({ id: samples.length, time: start / sr, ...feat, pcm: resampleLinear(raw, sr, outRate), rate: outRate });
  }
  samples.forEach((s, i) => { s.id = i; });
  return { samples, fallback, sampleRate: outRate };
}
