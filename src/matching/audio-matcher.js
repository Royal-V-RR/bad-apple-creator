// Chooses which recorded sample plays for each musical event, with controlled reuse.
import { midiToHz } from '../lib/fft.js';

export class SampleSelector {
  constructor(samples, settings, rng) {
    this.samples = samples;
    this.s = settings;
    this.rng = rng;
    this.uses = new Uint32Array(samples.length);
    this.last = new Float64Array(samples.length).fill(-1e9);
  }

  cost(smp, ev) {
    let c = 0;
    if (ev.kind === 'note') {
      c += (Math.abs(ev.midi - smp.baseMidi) / 12) * 0.9 + (smp.pitched ? 0 : 0.35);
      c += Math.min(1, Math.abs(Math.log(smp.duration / Math.max(0.05, ev.dur)))) * 0.2;
    } else {
      const target = ev.centroid || 3000;
      c += Math.abs(Math.log2(Math.max(100, smp.centroid) / target)) * 0.5;
      c += Math.abs(Math.log(smp.duration / 0.18)) * 0.15;
      c += Math.max(0, smp.duration - 0.4) * 0.4;
    }
    c += this.uses[smp.id] * (1 - this.s.reuse) * 0.6;
    if (ev.t - this.last[smp.id] < this.s.minSeparation) c += 3;
    c += this.rng() * this.s.variation * 1.5;
    return c;
  }

  select(ev) {
    if (!this.samples.length) return -1;
    let best = 0, bc = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const c = this.cost(this.samples[i], ev);
      if (c < bc) { bc = c; best = i; }
    }
    this.uses[best]++;
    this.last[best] = ev.t;
    return best;
  }

  stats() {
    let used = 0, plays = 0;
    for (const u of this.uses) { if (u) used++; plays += u; }
    return { distinctUsed: used, plays, reuse: plays / Math.max(1, used) };
  }
}

export const noteCentroid = (midi) => midiToHz(midi) * 2.5;
