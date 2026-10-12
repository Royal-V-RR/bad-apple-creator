import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureSet, pixelDist, coarseDist } from '../src/matching/features.js';
import { VisualMatcher, describeMatches, frameScore, calibrateScales } from '../src/matching/visual-matcher.js';
import { buildLibrary, planSampleTimes, otsu } from '../src/media/video-analysis.js';
import { Timeline } from '../src/render/timeline.js';
import { segmentAudio, buildSampleLibrary, hasUsableAudio, estimatePitch } from '../src/media/audio-analysis.js';
import { planAudio, AudioRenderer } from '../src/render/audio-mixer.js';
import { SampleSelector } from '../src/matching/audio-matcher.js';
import { Compositor } from '../src/render/compositor.js';
import { mulberry32 } from '../src/lib/rng.js';
import { packBits } from '../src/lib/bits.js';
import { DEFAULT_SETTINGS } from '../src/lib/config.js';

// ---- fixtures ----
const W = 64, H = 48;
function disc(cx, cy, r) { const g = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) g[y * W + x] = 1; return g; }
const toGray = (bin) => Uint8Array.from(bin, (v) => (v ? 230 : 25));
const shapes = [disc(16, 24, 10), disc(48, 24, 10), disc(32, 12, 8), disc(32, 36, 14)];

test('similarity: identical frames score zero, different frames score higher', () => {
  const a = new FeatureSet(shapes.length);
  shapes.forEach((s, i) => a.setFromBinary(i, s, W, H));
  assert.equal(pixelDist(a, 0, a, 0), 0);
  assert.equal(coarseDist(a, 1, a, 1), 0);
  assert.ok(pixelDist(a, 0, a, 1) > 0.05);
  const lib = { count: shapes.length, features: a };
  const scale = calibrateScales(a, shapes.length, lib);
  assert.ok(frameScore(a, 0, lib, 0, scale) < frameScore(a, 0, lib, 1, scale));
});

test('duplicate detection removes near identical frames and keeps distinct ones', () => {
  const frames = [shapes[0], shapes[0], shapes[0], shapes[1], shapes[1], shapes[2]].map(toGray);
  const lib = buildLibrary(frames, frames.map((_, i) => i), { w: W, h: H, dedupe: 0.02 });
  assert.equal(lib.count, 3);
  assert.equal(lib.removed, 3);
});

test('matching picks the right frame and reuses frames', () => {
  const lib0 = buildLibrary(shapes.map(toGray), [0, 1, 2, 3], { w: W, h: H, dedupe: 0.001 });
  const ref = new FeatureSet(8);
  const order = [0, 0, 0, 1, 1, 2, 3, 3];
  order.forEach((k, i) => ref.setFromBinary(i, shapes[k], W, H));
  const m = new VisualMatcher(lib0, { totalFrames: 8, candidates: 4, temporalPenalty: 0.6 });
  m.addReference(ref, 8);
  const out = m.solve();
  assert.deepEqual(Array.from(out), order);
  const longRef = new FeatureSet(40);
  for (let i = 0; i < 40; i++) longRef.setFromBinary(i, shapes[i % 2], W, H);
  const m2 = new VisualMatcher(lib0, { totalFrames: 40, candidates: 4, temporalPenalty: 0.6 });
  m2.addReference(longRef, 40);
  const stats = describeMatches(m2.solve(), lib0.count);
  assert.ok(stats.reuse >= 10, 'a library of 4 frames must cover 40 reference frames by reuse');
});

test('temporal penalty reduces switching without freezing the animation', () => {
  const lib0 = buildLibrary(shapes.map(toGray), [0, 1, 2, 3], { w: W, h: H, dedupe: 0.001 });
  const ref = new FeatureSet(60);
  for (let i = 0; i < 60; i++) ref.setFromBinary(i, shapes[Math.floor(i / 5) % 4], W, H);
  const run = (lambda) => { const m = new VisualMatcher(lib0, { totalFrames: 60, candidates: 4, temporalPenalty: lambda }); m.addReference(ref, 60); return describeMatches(m.solve(), 4); };
  assert.ok(run(0.6).switches <= run(0).switches);
  assert.ok(run(0.6).distinctUsed > 1);
});

test('sample times cover long clips evenly within the frame budget', () => {
  const t = planSampleTimes(100, 10, 50);
  assert.ok(t.length <= 50 && t.length >= 45);
  assert.ok(t[t.length - 1] > 90);
  assert.deepEqual(planSampleTimes(0.3, 10, 50).length >= 1, true);
  assert.ok(otsu(Float64Array.from({ length: 256 }, (_, i) => (i === 20 || i === 220 ? 100 : 0)), 200) < 220);
});

test('timeline: timestamps, frame mapping and audio ranges tile exactly (no drift)', () => {
  const tl = new Timeline({ refFps: 30, refFrames: 6572, outFps: 24, seconds: 219.0667, audioRate: 48000 });
  assert.equal(tl.refFrameAt(0), 0);
  assert.equal(tl.refFrameAt(1), 30);
  assert.equal(tl.refFrameAt(1e6), 6571);
  assert.equal(tl.timestampMicros(24), 1_000_000);
  let end = 0;
  for (let i = 0; i < tl.frameCount; i++) { const [a, b] = tl.audioRangeForFrame(i); assert.equal(a, end); end = b; }
  assert.equal(end, tl.audioSamples);
  const t15 = new Timeline({ refFps: 30, refFrames: 100, outFps: 15, seconds: 3, audioRate: 24000 });
  assert.equal(t15.refFrameForOutput(15), 30);
});

// ---- audio ----
const SR = 24000;
function synthClip() {
  const x = new Float32Array(SR * 4);
  const burst = (t, f, dur, amp = 0.6) => { const s = Math.floor(t * SR); for (let i = 0; i < dur * SR; i++) x[s + i] += amp * Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-i / (dur * SR * 0.6)); };
  burst(0.3, 220, 0.3); burst(1.0, 880, 0.15); burst(1.6, 440, 0.5); burst(2.8, 1760, 0.1);
  const rng = mulberry32(5);
  for (let i = 0; i < x.length; i++) x[i] += (rng() - 0.5) * 0.0004;
  return x;
}

test('audio: segmentation finds the separate sounds and silence is rejected', () => {
  const segs = segmentAudio(synthClip(), SR);
  assert.ok(segs.length >= 4 && segs.length <= 8, `found ${segs.length}`);
  assert.equal(hasUsableAudio(new Float32Array(SR)), false);
  assert.equal(buildSampleLibrary(new Float32Array(SR * 2), SR, SR).samples.length, 0);
  const { f0 } = estimatePitch(synthClip().subarray(Math.floor(0.3 * SR), Math.floor(0.6 * SR)), SR);
  assert.ok(Math.abs(f0 - 220) < 8, `f0 ${f0}`);
});

const events = { onsets: Array.from({ length: 30 }, (_, i) => [i * 0.2, 0.8, 2500]), notes: Array.from({ length: 20 }, (_, i) => [i * 0.3, 0.25, 60 + (i % 5), 0.7]) };

test('audio: sample library, reuse and deterministic planning', () => {
  const { samples } = buildSampleLibrary(synthClip(), SR, SR);
  assert.ok(samples.length >= 4);
  for (const mode of ['rhythm', 'remix', 'chaos']) {
    const s = { ...DEFAULT_SETTINGS, audioMode: mode };
    const a = planAudio(events, samples, s, 6), b = planAudio(events, samples, s, 6);
    assert.deepEqual(a.plan, b.plan, `${mode} must be deterministic`);
    assert.ok(a.plan.length > 20);
    assert.ok(a.stats.reuse > 2, `${mode}: ${samples.length} samples must be reused across ${a.plan.length} events`);
  }
});

test('audio: sample selection prefers matching pitch for notes and brightness for hits', () => {
  const mk = (id, baseMidi, centroid, duration) => ({ id, baseMidi, centroid, duration, pitched: true });
  const samples = [mk(0, 48, 300, 0.5), mk(1, 72, 3000, 0.1)];
  const sel = new SampleSelector(samples, { ...DEFAULT_SETTINGS, variation: 0, reuse: 1 }, mulberry32(1));
  assert.equal(sel.select({ kind: 'note', t: 0, midi: 71, dur: 0.2 }), 1);
  assert.equal(sel.select({ kind: 'note', t: 5, midi: 47, dur: 0.4 }), 0);
  assert.equal(sel.select({ kind: 'hit', t: 9, centroid: 4000 }), 1);
});

test('audio: renderer output is bounded, ranges render independently, and length is preserved', async () => {
  const { samples } = buildSampleLibrary(synthClip(), SR, SR);
  const settings = { ...DEFAULT_SETTINGS, audioMode: 'chaos', volume: 1.5 };
  const { plan } = planAudio(events, samples, settings, 6);
  const r = new AudioRenderer({ plan, samples, sampleRate: SR, totalSamples: SR * 6, settings });
  const full = await r.renderAll();
  assert.equal(full.length, SR * 6);
  let peak = 0; for (const v of full) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.05 && peak <= 1.0);
  const part = r.renderRange(SR * 2, SR * 3);
  assert.deepEqual(Array.from(part.subarray(0, 500)), Array.from(full.subarray(SR * 2, SR * 2 + 500)));
});

// ---- compositor ----
test('compositor follows the reference silhouette in both modes', () => {
  const lib = buildLibrary(shapes.map(toGray), [0, 1, 2, 3], { w: W, h: H, dedupe: 0.001 });
  const mask = new Uint8Array(128 * 96);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) mask[y * 128 + x] = x < 64 ? 1 : 0;
  const packed = packBits(mask);
  for (const visualMode of ['silhouette', 'mosaic']) {
    const comp = new Compositor({ outW: 160, outH: 120, maskW: 128, maskH: 96, lib, levels: { lo: 25, hi: 230 }, settings: { ...DEFAULT_SETTINGS, visualMode, texture: 0.3 } });
    const rgba = new Uint8ClampedArray(160 * 120 * 4);
    comp.render(rgba, packed, 0, 0);
    let left = 0, right = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) (x < 80 ? (left += rgba[(y * 160 + x) * 4]) : (right += rgba[(y * 160 + x) * 4]));
    assert.ok(left > right * 2, `${visualMode}: white half must be brighter (left ${left}, right ${right})`);
  }
});
