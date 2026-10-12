// Plans sound events from the reference timeline and mixes them deterministically into a mono buffer.
import { mulberry32 } from '../lib/rng.js';
import { SampleSelector, noteCentroid } from '../matching/audio-matcher.js';
import { renderVoice, softClip } from './dsp.js';

const MAX_VOICE_SEC = 4;

/** Merge onsets and note starts into a single trigger list, dropping near coincident triggers. */
export function buildTriggers(events, seconds, gap = 0.06) {
  const trig = [];
  for (const [t, strength, centroid] of events.onsets) if (t < seconds) trig.push({ t, vel: 0.35 + 0.65 * strength, centroid, dur: 0.2 });
  for (const [t, dur, midi, vel] of events.notes) if (t < seconds) trig.push({ t, vel: 0.35 + 0.65 * vel, centroid: noteCentroid(midi), dur: Math.min(dur, 0.45), midi });
  trig.sort((a, b) => a.t - b.t);
  const out = [];
  for (const e of trig) {
    const prev = out[out.length - 1];
    if (prev && e.t - prev.t < gap) { if (e.vel > prev.vel) out[out.length - 1] = e; continue; }
    out.push(e);
  }
  return out;
}

/**
 * Produce a sorted list of placements: { t, id, rate, dur, gain, reverse, drive }.
 * Pure and seeded, so planning twice with the same inputs gives identical output.
 */
export function planAudio(events, samples, settings, seconds) {
  const rng = mulberry32(settings.seed * 7919 + 13);
  const sel = new SampleSelector(samples, settings, rng);
  const plan = [];
  if (!samples.length) return { plan, stats: sel.stats() };
  const vary = () => (settings.pitchShift ? 1 + (rng() - 0.5) * settings.variation * 0.25 : 1);
  const mode = settings.audioMode;

  if (mode === 'remix') {
    for (const [t, dur, midi, vel] of events.notes) {
      if (t >= seconds) continue;
      const ev = { kind: 'note', t, dur: Math.max(0.08, dur), midi, vel };
      const id = sel.select(ev);
      const smp = samples[id];
      const rate = settings.pitchShift ? Math.pow(2, Math.max(-19, Math.min(19, midi - smp.baseMidi)) / 12) : 1;
      plan.push({ t, id, rate, dur: Math.min(ev.dur, 1.2), gain: 0.45 + 0.55 * vel, reverse: false, drive: 0 });
    }
    if (samples.length > 1) {
      for (const [t, strength, centroid] of events.onsets) {
        if (t >= seconds) continue;
        const id = sel.select({ kind: 'hit', t, centroid });
        plan.push({ t, id, rate: vary(), dur: 0, gain: 0.3 * strength + 0.1, reverse: false, drive: 0 });
      }
    }
  } else {
    const trig = buildTriggers(events, seconds);
    for (const e of trig) {
      const id = sel.select({ kind: 'hit', t: e.t, centroid: e.centroid });
      if (mode === 'rhythm') {
        plan.push({ t: e.t, id, rate: vary(), dur: 0, gain: 0.4 + 0.6 * e.vel, reverse: false, drive: 0 });
      } else {
        const layers = 1 + Math.floor(rng() * 3);
        for (let l = 0; l < layers; l++) {
          const lid = l === 0 ? id : sel.select({ kind: 'hit', t: e.t + l * 0.01, centroid: e.centroid * (0.5 + rng() * 2) });
          const rate = Math.exp((rng() - 0.5) * 2 * Math.log(2.2));
          const jitter = (rng() - 0.5) * 0.07;
          plan.push({ t: Math.max(0, e.t + jitter), id: lid, rate, dur: 0, gain: (0.3 + 0.5 * e.vel) / Math.sqrt(layers), reverse: rng() < 0.25, drive: rng() < 0.6 ? 1 + rng() * 5 : 0 });
        }
        if (rng() < 0.4) plan.push({ t: e.t + 0.09, id, rate: rate2(rng), dur: 0, gain: 0.3 * e.vel, reverse: rng() < 0.5, drive: 2 });
      }
    }
  }
  plan.sort((a, b) => a.t - b.t);
  return { plan, stats: sel.stats() };
}
const rate2 = (rng) => 0.7 + rng() * 0.8;

export class AudioRenderer {
  constructor({ plan, samples, sampleRate, totalSamples, settings }) {
    this.plan = plan;
    this.samples = samples;
    this.sr = sampleRate;
    this.total = totalSamples;
    this.settings = settings;
    this.cache = new Map();
    this.master = 0.5 * settings.volume;
  }

  voice(p) {
    const key = `${p.id}|${Math.round(p.rate * 500)}|${Math.round(p.dur * 50)}|${p.reverse ? 1 : 0}|${Math.round(p.drive * 4)}`;
    let v = this.cache.get(key);
    if (v) { this.cache.delete(key); this.cache.set(key, v); return v; }
    v = renderVoice(this.samples[p.id].pcm, this.sr, { rate: p.rate, targetDur: p.dur, reverse: p.reverse, drive: p.drive, fade: this.settings.fade });
    this.cache.set(key, v);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  firstIndexAfter(t) {
    let lo = 0, hi = this.plan.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.plan[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Mix the half open sample range [a, b) into a fresh Float32Array. Any range can be rendered independently. */
  renderRange(a, b) {
    const out = new Float32Array(Math.max(0, b - a));
    const t0 = a / this.sr, t1 = b / this.sr;
    for (let i = this.firstIndexAfter(t0 - MAX_VOICE_SEC); i < this.plan.length; i++) {
      const p = this.plan[i];
      if (p.t >= t1) break;
      const v = this.voice(p);
      const start = Math.round(p.t * this.sr) - a;
      const from = Math.max(0, -start), to = Math.min(v.length, out.length - start);
      const g = p.gain * this.master;
      for (let k = from; k < to; k++) out[start + k] += v[k] * g;
    }
    for (let i = 0; i < out.length; i++) out[i] = softClip(out[i]);
    return out;
  }

  /** Render the whole track in one second chunks so progress and cancellation stay responsive. */
  async renderAll(onProgress, shouldStop) {
    const full = new Float32Array(this.total);
    const chunk = this.sr;
    for (let a = 0; a < this.total; a += chunk) {
      if (shouldStop?.()) throw new DOMException('Cancelled', 'AbortError');
      const b = Math.min(this.total, a + chunk);
      full.set(this.renderRange(a, b), a);
      onProgress?.(b / this.total);
      await Promise.resolve();
    }
    return full;
  }
}
