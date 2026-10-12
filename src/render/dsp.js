// Small DSP toolbox: cubic resampling, WSOLA time stretching, and voice rendering for the mixer.
import { hann } from '../lib/fft.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function cubic(x, p) {
  const i = Math.floor(p), f = p - i;
  const a = x[i - 1] ?? x[0], b = x[i] ?? 0, c = x[i + 1] ?? 0, d = x[i + 2] ?? 0;
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

/** Read the signal at `rate` times normal speed. Changes pitch and length together. */
export function resampleRate(x, rate) {
  if (Math.abs(rate - 1) < 1e-4) return x;
  const out = new Float32Array(Math.max(1, Math.floor(x.length / rate)));
  for (let i = 0; i < out.length; i++) out[i] = cubic(x, i * rate);
  return out;
}

/** Waveform similarity overlap add. Changes length by `factor` without changing pitch. */
export function wsola(x, factor, sr) {
  const N = 2 * Math.round((sr * 0.032) / 2);
  if (x.length < N * 3 || Math.abs(factor - 1) < 0.03) return resampleRate(x, 1 / factor);
  const Hs = N >> 1, tol = N >> 3;
  const outLen = Math.round(x.length * factor);
  const out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
  const win = hann(N);
  let prevStart = 0;
  for (let k = 0, pos = 0; pos < outLen; k++, pos += Hs) {
    const nominal = Math.round((k * Hs) / factor);
    let start = clamp(nominal, 0, x.length - N);
    if (k > 0) {
      const target = prevStart + Hs;
      let best = -Infinity;
      for (let d = -tol; d <= tol; d += 3) {
        const s = clamp(nominal + d, 0, x.length - N);
        let c = 0;
        for (let i = 0; i < Hs; i += 4) c += x[s + i] * (x[target + i] ?? 0);
        if (c > best) { best = c; start = s; }
      }
    }
    for (let i = 0; i < N; i++) { out[pos + i] += x[start + i] * win[i]; norm[pos + i] += win[i]; }
    prevStart = start;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return res;
}

/**
 * Turn a library sample into a playable voice.
 * rate: pitch ratio. targetDur: seconds to fill (0 keeps the natural length).
 * When targetDur is set the sample is stretched with WSOLA so pitch and duration are controlled separately.
 */
export function renderVoice(pcm, sr, { rate = 1, targetDur = 0, reverse = false, drive = 0, fade = 0.01 } = {}) {
  let x = pcm;
  if (targetDur > 0) {
    const factor = clamp((targetDur * sr * rate) / x.length, 0.6, 3);
    if (Math.abs(factor - 1) > 0.05) x = wsola(x, factor, sr);
  }
  x = resampleRate(x, rate);
  if (x === pcm) x = x.slice();
  const limit = targetDur > 0 ? Math.floor(targetDur * sr * 1.05) : 0;
  if (limit && x.length > limit) x = x.slice(0, limit);
  if (reverse) x.reverse();
  if (drive > 0) {
    const norm = Math.tanh(drive);
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / norm;
  }
  const fi = Math.min(x.length >> 1, Math.max(1, Math.round(sr * 0.0015)));
  const fo = Math.min(x.length >> 1, Math.max(1, Math.round(sr * Math.max(fade, 0.003))));
  for (let i = 0; i < fi; i++) x[i] *= i / fi;
  for (let i = 0; i < fo; i++) x[x.length - 1 - i] *= i / fo;
  return x;
}

export function softClip(v) {
  const a = Math.abs(v);
  if (a <= 0.8) return v;
  const s = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
  return v < 0 ? -s : s;
}
