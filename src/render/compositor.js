// Frame reconstruction. Works on plain typed arrays so it runs in a browser, a worker, or Node tests.
import { unpackBits } from '../lib/bits.js';

const BAYER8 = (() => {
  const m = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
  return Float32Array.from(m, (v) => (v + 0.5) / 64);
})();

const hash2 = (a, b) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

function axisTable(outN, srcN, p) {
  const i0 = new Int32Array(outN), i1 = new Int32Array(outN), f = new Float32Array(outN), blk = new Int32Array(outN);
  for (let x = 0; x < outN; x++) {
    const q = p > 1 ? Math.floor(x / p) * p + p / 2 : x + 0.5;
    let u = (q / outN) * srcN - 0.5;
    u = Math.max(0, Math.min(srcN - 1, u));
    const a = Math.floor(u);
    i0[x] = a; i1[x] = Math.min(srcN - 1, a + 1); f[x] = u - a;
    blk[x] = p > 1 ? Math.floor(x / p) : x;
  }
  return { i0, i1, f, blk };
}

export class Compositor {
  /**
   * @param o.outW,outH   output size
   * @param o.maskW,maskH reference mask size
   * @param o.lib         { count, w, h, gray }
   * @param o.levels      { lo, hi } tone range of the library
   * @param o.settings    visual settings (see DEFAULT_SETTINGS)
   */
  constructor({ outW, outH, maskW, maskH, lib, levels, settings, mosaicCols = 20, mosaicRows = 15 }) {
    Object.assign(this, { outW, outH, maskW, maskH, lib, settings });
    this.mask = new Uint8Array(maskW * maskH);
    const p = Math.max(1, Math.round(settings.pixelate));
    this.mx = axisTable(outW, maskW, p);
    this.my = axisTable(outH, maskH, p);
    this.sx = axisTable(outW, lib.w, p);
    this.sy = axisTable(outH, lib.h, p);
    this.tone = new Float32Array(256);
    const span = Math.max(1, levels.hi - levels.lo);
    for (let g = 0; g < 256; g++) {
      let t = Math.max(0, Math.min(1, ((g - levels.lo) / span - 0.5) * settings.contrast + 0.5));
      this.tone[g] = settings.invert ? 1 - t : t;
    }
    if (settings.visualMode === 'mosaic') this.buildAtlas(mosaicCols, mosaicRows);
  }

  finish(v, bx, by) {
    const d = this.settings.dither;
    if (d === 'gray') return v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255);
    return v > BAYER8[((by & 7) << 3) | (bx & 7)] ? 255 : 0;
  }

  /** Mode A: the reference silhouette decides which regions are light or dark, the matched frame fills them. */
  renderSilhouette(out, packed, libIndex) {
    const { outW, outH, mask, mx, my, sx, sy, lib, tone } = this;
    const { maskW } = this;
    unpackBits(packed, mask.length, mask);
    const tex = this.settings.texture;
    const hard = this.settings.dither === 'none';
    const gray = lib.gray, base = libIndex * lib.w * lib.h, w = lib.w;
    let o = 0;
    for (let y = 0; y < outH; y++) {
      const m0 = my.i0[y] * maskW, m1 = my.i1[y] * maskW, fy = my.f[y];
      const s0 = base + sy.i0[y] * w, s1 = base + sy.i1[y] * w, sfy = sy.f[y];
      for (let x = 0; x < outW; x++, o += 4) {
        const ax = mx.i0[x], bx = mx.i1[x], fx = mx.f[x];
        const top = mask[m0 + ax] * (1 - fx) + mask[m0 + bx] * fx;
        const bot = mask[m1 + ax] * (1 - fx) + mask[m1 + bx] * fx;
        const region = top * (1 - fy) + bot * fy >= 0.5;
        const cx = sx.i0[x], dx = sx.i1[x], sf = sx.f[x];
        const g = (gray[s0 + cx] * (1 - sf) + gray[s0 + dx] * sf) * (1 - sfy) + (gray[s1 + cx] * (1 - sf) + gray[s1 + dx] * sf) * sfy;
        const t = tone[g | 0];
        let val;
        if (hard) val = region ? (t < 0.3 * tex ? 0 : 255) : (t > 1 - 0.3 * tex ? 255 : 0);
        else val = this.finish(region ? 1 - 0.55 * tex * (1 - t) : 0.55 * tex * t, sx.blk[x], sy.blk[y]);
        out[o] = out[o + 1] = out[o + 2] = val;
        out[o + 3] = 255;
      }
    }
  }

  // ----- Mosaic ---------------------------------------------------------------------------------------------

  buildAtlas(cols, rows) {
    const { lib, outW, outH, tone } = this;
    this.cols = cols; this.rows = rows;
    const cw = Math.max(2, Math.round(outW / cols)), ch = Math.max(2, Math.round(outH / rows));
    this.cw = cw; this.ch = ch;
    const n = lib.count;
    const tiles = new Float32Array(n * cw * ch), mean = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let y = 0; y < ch; y++) {
        const y0 = Math.floor((y * lib.h) / ch), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * lib.h) / ch));
        for (let x = 0; x < cw; x++) {
          const x0 = Math.floor((x * lib.w) / cw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * lib.w) / cw));
          let s = 0, c = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += lib.gray[i * lib.w * lib.h + yy * lib.w + xx]; c++; }
          const t = tone[Math.round(s / c)];
          tiles[i * cw * ch + y * cw + x] = t;
          sum += t;
        }
      }
      mean[i] = sum / (cw * ch);
    }
    this.tiles = tiles; this.tileMean = mean;
    this.order = Uint16Array.from({ length: n }, (_, i) => i).sort((a, b) => mean[a] - mean[b]);
  }

  /** Mode B: a grid of reduced source frames. Dark and light cells pick tiles by brightness, edge cells show the matched frame. */
  renderMosaic(out, packed, libIndex, refFrame) {
    const { outW, outH, mask, maskW, maskH, cols, rows, cw, ch, tiles, tileMean, order, lib, tone } = this;
    unpackBits(packed, mask.length, mask);
    const n = lib.count, hold = 12;      // a cell may change tile every 12 reference frames at most
    const tex = Math.min(1, this.settings.texture + 0.25);
    const gridW = cw * cols, gridH = ch * rows;
    const base = libIndex * lib.w * lib.h;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const mx0 = Math.floor((cx * maskW) / cols), mx1 = Math.max(mx0 + 1, Math.floor(((cx + 1) * maskW) / cols));
        const my0 = Math.floor((cy * maskH) / rows), my1 = Math.max(my0 + 1, Math.floor(((cy + 1) * maskH) / rows));
        let s = 0;
        for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) s += mask[y * maskW + x];
        const b = s / ((mx1 - mx0) * (my1 - my0));
        const edgeCell = b > 0.12 && b < 0.88;
        const cell = cy * cols + cx;
        const bucket = Math.floor((refFrame + hash2(cell, 17) * hold) / hold);
        const r = hash2(cell, bucket);
        let tile = 0;
        if (!edgeCell) {
          const pos = b * (n - 1), band = Math.max(1, 0.12 * n);
          const idx = Math.max(0, Math.min(n - 1, Math.round(b < 0.5 ? pos + r * band : pos - r * band)));
          tile = order[idx];
        }
        const target = 0.1 + 0.8 * b;
        for (let py = 0; py < ch; py++) {
          const y = cy * ch + py;
          if (y >= outH) break;
          for (let px = 0; px < cw; px++) {
            const x = cx * cw + px;
            if (x >= outW) break;
            let v;
            if (edgeCell) {
              const u = ((cx + (px + 0.5) / cw) * lib.w) / cols, vv = ((cy + (py + 0.5) / ch) * lib.h) / rows;
              const t = tone[lib.gray[base + Math.min(lib.h - 1, vv | 0) * lib.w + Math.min(lib.w - 1, u | 0)]];
              v = target * (1 - tex) + t * tex;
            } else {
              const t = tiles[tile * cw * ch + py * cw + px];
              v = target + (t - tileMean[tile]) * tex * (0.35 + 1.3 * Math.min(target, 1 - target));
            }
            const val = this.finish(v, x >> 0, y >> 0);
            const o = (y * outW + x) * 4;
            out[o] = out[o + 1] = out[o + 2] = val; out[o + 3] = 255;
          }
        }
      }
    }
    // Pad any strip left over when the output size is not a multiple of the tile grid.
    for (let y = 0; y < outH; y++) {
      for (let x = (y < gridH ? gridW : 0); x < outW; x++) { const o = (y * outW + x) * 4; out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 255; }
    }
  }

  render(out, packed, libIndex, refFrame) {
    if (this.settings.visualMode === 'mosaic') this.renderMosaic(out, packed, libIndex, refFrame);
    else this.renderSilhouette(out, packed, libIndex);
  }
}
