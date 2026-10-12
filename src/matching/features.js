// Compact per frame descriptors used for visual matching, shared by reference frames and source frames.
import { packWords, hamming } from '../lib/bits.js';

export const GRID_W = 32;
export const GRID_H = 24;
export const GRID_N = GRID_W * GRID_H; // 768 bits
export const WORDS = GRID_N >> 5;      // 24 words
export const COARSE_W = 8;
export const COARSE_H = 6;
export const COARSE_N = COARSE_W * COARSE_H;

/** Coverage (0..255, share of white pixels) of each cell of a GRID_W x GRID_H grid over a w x h binary image. */
export function coverageGrid(bin, w, h, out = new Uint8Array(GRID_N)) {
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor((gy * h) / GRID_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * w) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / GRID_W));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += bin[y * w + x];
      out[gy * GRID_W + gx] = Math.round((255 * sum) / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

export class FeatureSet {
  constructor(n) {
    this.n = n;
    this.bits = new Uint32Array(n * WORDS);
    this.coarse = new Uint8Array(n * COARSE_N);
    this.row = new Uint8Array(n * GRID_H);
    this.col = new Uint8Array(n * GRID_W);
    this.fg = new Uint8Array(n);
    this.edge = new Uint8Array(n);
  }

  /** Describe a binary image (values 0 or 1) and store the descriptor at slot i. */
  setFromBinary(i, bin, w, h, cov = new Uint8Array(GRID_N)) {
    coverageGrid(bin, w, h, cov);
    const gridBits = new Uint8Array(GRID_N);
    let total = 0;
    for (let k = 0; k < GRID_N; k++) { gridBits[k] = cov[k] >= 128 ? 1 : 0; total += cov[k]; }
    this.bits.set(packWords(gridBits), i * WORDS);
    // coarse 8x6 coverage: 4x4 blocks of the grid
    for (let cy = 0; cy < COARSE_H; cy++) {
      for (let cx = 0; cx < COARSE_W; cx++) {
        let s = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s += cov[(cy * 4 + y) * GRID_W + cx * 4 + x];
        this.coarse[i * COARSE_N + cy * COARSE_W + cx] = Math.round(s / 16);
      }
    }
    for (let y = 0; y < GRID_H; y++) {
      let s = 0;
      for (let x = 0; x < GRID_W; x++) s += cov[y * GRID_W + x];
      this.row[i * GRID_H + y] = Math.round(s / GRID_W);
    }
    for (let x = 0; x < GRID_W; x++) {
      let s = 0;
      for (let y = 0; y < GRID_H; y++) s += cov[y * GRID_W + x];
      this.col[i * GRID_W + x] = Math.round(s / GRID_H);
    }
    this.fg[i] = Math.round(total / GRID_N);
    let trans = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const v = gridBits[y * GRID_W + x];
        if (x + 1 < GRID_W && v !== gridBits[y * GRID_W + x + 1]) trans++;
        if (y + 1 < GRID_H && v !== gridBits[(y + 1) * GRID_W + x]) trans++;
      }
    }
    this.edge[i] = Math.min(255, Math.round((255 * trans) / (GRID_N * 0.5)));
  }

  /** Structured clone friendly form, used to hand a library to a worker. */
  toPlain() { const { n, bits, coarse, row, col, fg, edge } = this; return { n, bits, coarse, row, col, fg, edge }; }

  static fromPlain(p) { return Object.assign(Object.create(FeatureSet.prototype), p); }

  /** Copy slot j of another set into slot i of this one. */
  copyFrom(i, other, j) {
    this.bits.set(other.bits.subarray(j * WORDS, (j + 1) * WORDS), i * WORDS);
    this.coarse.set(other.coarse.subarray(j * COARSE_N, (j + 1) * COARSE_N), i * COARSE_N);
    this.row.set(other.row.subarray(j * GRID_H, (j + 1) * GRID_H), i * GRID_H);
    this.col.set(other.col.subarray(j * GRID_W, (j + 1) * GRID_W), i * GRID_W);
    this.fg[i] = other.fg[j];
    this.edge[i] = other.edge[j];
  }
}

// Individual normalised distances (each 0..1 before scale calibration).
export function pixelDist(A, i, B, j) { return hamming(A.bits, i * WORDS, B.bits, j * WORDS, WORDS) / GRID_N; }

export function coarseDist(A, i, B, j) {
  let s = 0;
  const a = i * COARSE_N, b = j * COARSE_N;
  for (let k = 0; k < COARSE_N; k++) s += Math.abs(A.coarse[a + k] - B.coarse[b + k]);
  return s / (COARSE_N * 255);
}

export function occupancyDist(A, i, B, j) {
  let s = 0;
  const ar = i * GRID_H, br = j * GRID_H, ac = i * GRID_W, bc = j * GRID_W;
  for (let k = 0; k < GRID_H; k++) s += Math.abs(A.row[ar + k] - B.row[br + k]);
  for (let k = 0; k < GRID_W; k++) s += Math.abs(A.col[ac + k] - B.col[bc + k]);
  return s / ((GRID_H + GRID_W) * 255);
}

export const fgDist = (A, i, B, j) => Math.abs(A.fg[i] - B.fg[j]) / 255;
export const edgeDist = (A, i, B, j) => Math.abs(A.edge[i] - B.edge[j]) / 255;
