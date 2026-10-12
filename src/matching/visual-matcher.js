// Visual similarity scoring and temporally coherent matching of source frames to reference frames.
import {
  FeatureSet, WORDS, pixelDist, coarseDist, occupancyDist, fgDist, edgeDist,
} from './features.js';
import { mulberry32 } from '../lib/rng.js';

const FEATURES = ['coarse', 'occupancy', 'fg', 'edge', 'pixel'];
const WEIGHTS = { coarse: 0.3, occupancy: 0.15, fg: 0.15, edge: 0.1, pixel: 0.3 };

/**
 * Estimate the average distance of each feature over random pairs so that every term is divided by its own
 * typical magnitude. This stops any single feature from dominating the combined score.
 */
export function calibrateScales(refSet, refCount, lib, seed = 7, samples = 1500) {
  const rng = mulberry32(seed);
  const sums = { coarse: 0, occupancy: 0, fg: 0, edge: 0, pixel: 0 };
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rng() * refCount);
    const j = Math.floor(rng() * lib.count);
    sums.coarse += coarseDist(refSet, i, lib.features, j);
    sums.occupancy += occupancyDist(refSet, i, lib.features, j);
    sums.fg += fgDist(refSet, i, lib.features, j);
    sums.edge += edgeDist(refSet, i, lib.features, j);
    sums.pixel += pixelDist(refSet, i, lib.features, j);
  }
  const scale = {};
  for (const f of FEATURES) scale[f] = Math.max(1e-4, sums[f] / samples);
  return scale;
}

/** Combined, normalised score of a source frame j against reference frame i. Lower is better. */
export function frameScore(refSet, i, lib, j, scale, refine = true) {
  const F = lib.features;
  let s = WEIGHTS.coarse * (coarseDist(refSet, i, F, j) / scale.coarse)
    + WEIGHTS.occupancy * (occupancyDist(refSet, i, F, j) / scale.occupancy)
    + WEIGHTS.fg * (fgDist(refSet, i, F, j) / scale.fg)
    + WEIGHTS.edge * (edgeDist(refSet, i, F, j) / scale.edge);
  if (refine) s += WEIGHTS.pixel * (pixelDist(refSet, i, F, j) / scale.pixel);
  return s;
}

export class VisualMatcher {
  /**
   * @param lib { count, features: FeatureSet, times: Float32Array }
   * @param opts { totalFrames, candidates, temporalPenalty, seed }
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.T = opts.totalFrames;
    this.K = Math.max(1, Math.min(opts.candidates, lib.count));
    this.lambda = opts.temporalPenalty;
    this.seed = opts.seed ?? 7;
    this.candIdx = new Uint16Array(this.T * this.K);
    this.candCost = new Float32Array(this.T * this.K);
    this.filled = 0;
    this.scale = null;
    this.lastRef = null;
    this.stats = { comparisons: 0, reusedLists: 0 };
    this.pair = null;
  }

  /** Select the K best candidates for each reference frame in `refSet` (frames start .. start+count). */
  addReference(refSet, count) {
    const { lib, K } = this;
    if (!this.scale) this.scale = calibrateScales(refSet, count, lib, this.seed);
    const scale = this.scale;
    const topIdx = new Int32Array(K), topScore = new Float32Array(K);
    for (let i = 0; i < count; i++) {
      const t = this.filled + i;
      const o = t * this.K;
      // Identical consecutive reference frames share a candidate list. No need to score them again.
      if (t > 0 && this.sameAsPrevious(refSet, i, count)) {
        this.candIdx.copyWithin(o, o - K, o);
        this.candCost.copyWithin(o, o - K, o);
        this.stats.reusedLists++;
        continue;
      }
      let have = 0;
      for (let j = 0; j < lib.count; j++) {
        const sc = frameScore(refSet, i, lib, j, scale, false);
        this.stats.comparisons++;
        if (have < K || sc < topScore[have - 1]) {
          let p = have < K ? have++ : K - 1;
          while (p > 0 && topScore[p - 1] > sc) { topScore[p] = topScore[p - 1]; topIdx[p] = topIdx[p - 1]; p--; }
          topScore[p] = sc; topIdx[p] = j;
        }
      }
      // Refinement stage: pixel level disagreement for the shortlisted candidates only.
      for (let k = 0; k < have; k++) {
        this.candIdx[o + k] = topIdx[k];
        this.candCost[o + k] = frameScore(refSet, i, lib, topIdx[k], scale, true);
      }
      for (let k = have; k < K; k++) { this.candIdx[o + k] = topIdx[0]; this.candCost[o + k] = 1e3; }
    }
    this.lastRef = { set: refSet, i: count - 1 };
    this.filled += count;
  }

  sameAsPrevious(refSet, i, count) {
    if (i > 0) return this.rowEqual(refSet, i, refSet, i - 1);
    if (!this.lastRef) return false;
    return this.rowEqual(refSet, 0, this.lastRef.set, this.lastRef.i);
  }

  rowEqual(A, i, B, j) {
    const a = i * WORDS, b = j * WORDS;
    for (let w = 0; w < WORDS; w++) if (A.bits[a + w] !== B.bits[b + w]) return false;
    return A.fg[i] === B.fg[j];
  }

  pairDistances() {
    if (this.pair) return this.pair;
    const n = this.lib.count;
    const d = new Float32Array(n * n);
    let sum = 0, cnt = 0;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const v = coarseDist(this.lib.features, a, this.lib.features, b);
        d[a * n + b] = d[b * n + a] = v;
        sum += v; cnt++;
      }
    }
    const mean = cnt ? sum / cnt : 1;
    for (let i = 0; i < d.length; i++) d[i] /= Math.max(mean, 1e-4);
    this.pair = d;
    return d;
  }

  /** Viterbi search over the candidate lists with a switching penalty. Returns Uint16Array of library indices. */
  solve() {
    const { T, K, lib } = this;
    const n = lib.count;
    const out = new Uint16Array(T);
    if (T === 0) return out;
    const pair = this.pairDistances();
    const times = lib.times;
    const back = new Uint8Array(T * K);
    let prev = new Float32Array(K), cur = new Float32Array(K);
    for (let k = 0; k < K; k++) prev[k] = this.candCost[k];
    for (let t = 1; t < T; t++) {
      const o = t * K, po = (t - 1) * K;
      for (let b = 0; b < K; b++) {
        const cb = this.candIdx[o + b];
        let best = Infinity, arg = 0;
        for (let a = 0; a < K; a++) {
          const ca = this.candIdx[po + a];
          let trans = 0;
          if (ca !== cb) {
            const adjacent = Math.abs(ca - cb) <= 1 || Math.abs(times[ca] - times[cb]) < 0.2;
            trans = this.lambda * (0.4 + 1.6 * pair[ca * n + cb]) * (adjacent ? 0.4 : 1);
          }
          const v = prev[a] + trans;
          if (v < best) { best = v; arg = a; }
        }
        cur[b] = best + this.candCost[o + b];
        back[o + b] = arg;
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    let k = 0;
    for (let b = 1; b < K; b++) if (prev[b] < prev[k]) k = b;
    for (let t = T - 1; t >= 0; t--) {
      out[t] = this.candIdx[t * K + k];
      k = back[t * K + k];
    }
    return out;
  }
}

/** Convenience: statistics used by the UI and the tests. */
export function describeMatches(matches, libCount) {
  const used = new Set(matches);
  let switches = 0;
  for (let i = 1; i < matches.length; i++) if (matches[i] !== matches[i - 1]) switches++;
  return { frames: matches.length, distinctUsed: used.size, libCount, switches, reuse: matches.length / Math.max(1, used.size) };
}

export { FeatureSet };
