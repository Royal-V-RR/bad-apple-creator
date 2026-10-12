// Loads the preprocessed Bad Apple!! reference data in chunks. Only a few chunks stay in memory at once.
import { unpackBits } from '../lib/bits.js';

async function defaultGunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ReferenceData {
  /**
   * @param opts.baseUrl  directory URL that contains manifest.json (works under a GitHub Pages subpath)
   * @param opts.fetchBytes  async (url) => Uint8Array, injectable for tests
   * @param opts.gunzip      async (Uint8Array) => Uint8Array, injectable for tests
   * @param opts.cache       optional { get, set } used for chunk bytes (content hashed names never go stale)
   */
  constructor({ baseUrl, fetchBytes, gunzip = defaultGunzip, cache = null, verify = true, maxChunks = 3 }) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.fetchBytes = fetchBytes || (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    });
    this.gunzip = gunzip;
    this.cache = cache;
    this.verify = verify;
    this.maxChunks = maxChunks;
    this.chunks = new Map(); // chunk index -> decoded Uint8Array (LRU by insertion order)
    this.pending = new Map();
    this.manifest = null;
  }

  async init() {
    const bytes = await this.fetchBytes(`${this.baseUrl}manifest.json`);
    this.manifest = JSON.parse(new TextDecoder().decode(bytes));
    const m = this.manifest;
    this.frames = m.frames;
    this.fps = m.fps;
    this.duration = m.duration;
    this.maskW = m.mask.width;
    this.maskH = m.mask.height;
    this.bytesPerFrame = m.mask.bytesPerFrame;
    return m;
  }

  get version() { return `${this.manifest.version}:${this.manifest.chunks[0].sha256.slice(0, 12)}:${this.frames}`; }

  timeToFrame(t) { return Math.max(0, Math.min(this.frames - 1, Math.floor(t * this.fps + 1e-6))); }

  chunkOf(frame) { return Math.min(this.manifest.chunks.length - 1, Math.floor(frame / this.manifest.chunks[0].count)); }

  async loadChunk(ci) {
    if (this.chunks.has(ci)) {
      const v = this.chunks.get(ci);
      this.chunks.delete(ci); this.chunks.set(ci, v);
      return v;
    }
    if (this.pending.has(ci)) return this.pending.get(ci);
    const p = (async () => {
      const info = this.manifest.chunks[ci];
      let gz = this.cache ? await this.cache.get(`ref:${info.sha256}`) : null;
      if (!gz) {
        gz = await this.fetchBytes(`${this.baseUrl}${info.file}`);
        if (this.verify) {
          const h = await sha256Hex(gz);
          if (h && h !== info.sha256) throw new Error(`Reference chunk ${info.file} failed its checksum`);
        }
        if (this.cache) this.cache.set(`ref:${info.sha256}`, gz);
      }
      const raw = await this.gunzip(gz);
      const bpf = this.bytesPerFrame;
      if (raw.length !== info.count * bpf) throw new Error(`Reference chunk ${info.file} has an unexpected size`);
      for (let f = 1; f < info.count; f++) {            // undo the xor-previous delta coding
        const o = f * bpf, po = (f - 1) * bpf;
        for (let i = 0; i < bpf; i++) raw[o + i] ^= raw[po + i];
      }
      this.chunks.set(ci, raw);
      while (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value);
      return raw;
    })();
    this.pending.set(ci, p);
    try { return await p; } finally { this.pending.delete(ci); }
  }

  /** Packed bits of one frame (a view into the chunk buffer, treat as read only). */
  async getPacked(frame) {
    const ci = this.chunkOf(frame);
    const raw = await this.loadChunk(ci);
    const local = frame - this.manifest.chunks[ci].start;
    return raw.subarray(local * this.bytesPerFrame, (local + 1) * this.bytesPerFrame);
  }

  /** Unpacked 0/1 mask of one frame. */
  async getMask(frame, out) {
    return unpackBits(await this.getPacked(frame), this.maskW * this.maskH, out);
  }

  /** Synchronous access once the chunk is resident. Returns null if it still has to be loaded. */
  peekPacked(frame) {
    const ci = this.chunkOf(frame);
    const raw = this.chunks.get(ci);
    if (!raw) return null;
    const local = frame - this.manifest.chunks[ci].start;
    return raw.subarray(local * this.bytesPerFrame, (local + 1) * this.bytesPerFrame);
  }

  async loadAudioEvents() {
    const info = this.manifest.audioEvents;
    const bytes = await this.fetchBytes(`${this.baseUrl}${info.file}`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}
