import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ReferenceData } from '../src/reference/loader.js';

const dir = new URL('../public/reference/', import.meta.url);
const makeRef = () => new ReferenceData({
  baseUrl: 'ref/',
  fetchBytes: async (u) => new Uint8Array(await readFile(new URL(u.replace('ref/', ''), dir))),
  gunzip: async (b) => new Uint8Array(gunzipSync(b)),
  verify: false,
});

test('manifest describes the reference timeline', async () => {
  const ref = makeRef();
  const m = await ref.init();
  assert.equal(m.fps, 30);
  assert.equal(m.frames, 6572);
  assert.ok(m.timestamps.uniform);
  assert.equal(ref.timeToFrame(0), 0);
  assert.equal(ref.timeToFrame(1), 30);
  assert.equal(ref.timeToFrame(9999), m.frames - 1);
});

test('decoded masks match frames extracted directly with ffmpeg', async () => {
  const ref = makeRef();
  await ref.init();
  for (const frame of [0, 299, 300, 1234, 6571]) {
    const t = frame / 30;
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', new URL('../badapple.mp4', import.meta.url).pathname,
      '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=128:96:flags=area', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    const mask = await ref.getMask(frame);
    let diff = 0;
    for (let i = 0; i < mask.length; i++) diff += (raw[i] >= 128 ? 1 : 0) !== mask[i] ? 1 : 0;
    assert.ok(diff / mask.length < 0.01, `frame ${frame} differs in ${diff} pixels`);
  }
});

test('chunk cache stays bounded', async () => {
  const ref = makeRef();
  await ref.init();
  for (let c = 0; c < 8; c++) await ref.getPacked(c * 300);
  assert.ok(ref.chunks.size <= ref.maxChunks);
});

test('audio events are available', async () => {
  const ref = makeRef();
  await ref.init();
  const ev = await ref.loadAudioEvents();
  assert.ok(ev.notes.length > 100 && ev.onsets.length > 100);
});
