#!/usr/bin/env node
// Development check: runs the real pipeline modules in Node against a synthetic clip and writes sample frames,
// an audio WAV, and a muxed MP4 via ffmpeg. Browser only parts (video element, WebCodecs) are replaced by ffmpeg.
//   node scripts/simulate.mjs [outDir] [source.mp4]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ReferenceData } from '../src/reference/loader.js';
import { PRESETS, DEFAULT_SETTINGS, REF } from '../src/lib/config.js';
import { buildLibrary, libraryLevels, planSampleTimes } from '../src/media/video-analysis.js';
import { buildSampleLibrary } from '../src/media/audio-analysis.js';
import { VisualMatcher, describeMatches, FeatureSet } from '../src/matching/visual-matcher.js';
import { Compositor } from '../src/render/compositor.js';
import { Timeline } from '../src/render/timeline.js';
import { planAudio, AudioRenderer } from '../src/render/audio-mixer.js';
import { unpackBits } from '../src/lib/bits.js';

const outDir = process.argv[2] || '/tmp/sim';
let src = process.argv[3];
const presetName = process.env.PRESET || 'balanced';
const seconds = Number(process.env.SECONDS || 20);
const startAt = Number(process.env.START || 0);
const settings = { ...DEFAULT_SETTINGS, preset: presetName, visualMode: process.env.VMODE || 'silhouette', audioMode: process.env.AMODE || 'rhythm' };
const P = PRESETS[presetName];
mkdirSync(outDir, { recursive: true });

if (!src) {
  src = join(outDir, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:a=0.2',
    '-filter_complex', '[1][2]amix=inputs=2,volume=2,tremolo=f=3:d=0.9[a]', '-map', '0:v', '-map', '[a]', '-shortest', '-pix_fmt', 'yuv420p', src]);
}
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString());
const t0 = performance.now();
const lap = (m) => console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s ${m}`);

// stage 2: frames (ffmpeg stands in for the browser's video element)
const times = planSampleTimes(dur, P.sampleFps, P.maxFrames);
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', `fps=${(times.length / dur).toFixed(5)},scale=${P.workW * 2}:${P.workH * 2}:force_original_aspect_ratio=increase,crop=${P.workW * 2}:${P.workH * 2},scale=${P.workW}:${P.workH}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 29 });
const fsz = P.workW * P.workH;
const frames = [];
for (let i = 0; i + fsz <= raw.length; i += fsz) frames.push(new Uint8Array(raw.buffer, raw.byteOffset + i, fsz).slice());
const ftimes = frames.map((_, i) => (i * dur) / frames.length);
lap(`${frames.length} frames extracted`);

// stage 4: library
const lib = buildLibrary(frames, ftimes, { w: P.workW, h: P.workH, threshold: settings.threshold, adaptive: settings.adaptive, contrast: settings.contrast, invert: settings.invert, dedupe: P.dedupe });
lap(`library ${lib.count} frames (${lib.removed} duplicates removed), threshold ${lib.threshold}`);

// reference + stage 6 matching (chunked)
const dirUrl = new URL('../public/reference/', import.meta.url);
const ref = new ReferenceData({ baseUrl: 'ref/', fetchBytes: async (u) => new Uint8Array(readFileSync(new URL(u.replace('ref/', ''), dirUrl))), gunzip: async (b) => new Uint8Array(gunzipSync(b)), verify: false });
await ref.init();
const tl = new Timeline({ refFps: ref.fps, refFrames: ref.frames, outFps: P.outFps, seconds: startAt + seconds, audioRate: P.audioRate });
const useFrames = Math.min(ref.frames, Math.ceil((startAt + seconds) * ref.fps));
const matcher = new VisualMatcher(lib, { totalFrames: useFrames, candidates: P.candidates, temporalPenalty: settings.temporalPenalty });
for (let c = 0, done = 0; done < useFrames; c++) {
  const raw2 = await ref.loadChunk(c);
  const info = ref.manifest.chunks[c];
  const count = Math.min(info.count, useFrames - done);
  const set = new FeatureSet(count);
  const bin = new Uint8Array(REF.maskW * REF.maskH);
  for (let f = 0; f < count; f++) { unpackBits(raw2.subarray(f * ref.bytesPerFrame, (f + 1) * ref.bytesPerFrame), bin.length, bin); set.setFromBinary(f, bin, REF.maskW, REF.maskH); }
  matcher.addReference(set, count);
  done += count;
}
const matches = matcher.solve();
console.log(describeMatches(matches, lib.count), matcher.stats);
lap('matched');

// audio
const wav = join(outDir, 'src.f32');
const pcmRaw = execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
const mono = new Float32Array(pcmRaw.buffer, pcmRaw.byteOffset, pcmRaw.byteLength >> 2);
const sl = buildSampleLibrary(mono, 44100, P.audioRate);
console.log(`sample library: ${sl.samples.length} samples${sl.fallback ? ' (fallback segmentation)' : ''}`);
const events = await ref.loadAudioEvents();
const { plan, stats } = planAudio(events, sl.samples, settings, startAt + seconds);
console.log('audio plan', plan.length, 'events', stats);
const renderer = new AudioRenderer({ plan, samples: sl.samples, sampleRate: P.audioRate, totalSamples: tl.audioSamples, settings });
const audio = await renderer.renderAll();
let peak = 0; for (const v of audio) peak = Math.max(peak, Math.abs(v));
console.log('audio peak', peak.toFixed(3));
lap('audio rendered');

// frames
const comp = new Compositor({ outW: P.outW, outH: P.outH, maskW: ref.maskW, maskH: ref.maskH, lib, levels: libraryLevels(lib), settings });
const rgba = new Uint8ClampedArray(P.outW * P.outH * 4);
const gray = Buffer.alloc(P.outW * P.outH);
const startFrame = Math.round(startAt * P.outFps);
const outFrames = Math.round(seconds * P.outFps);
const rawVideo = join(outDir, 'out.gray');
const chunksOut = [];
for (let i = startFrame; i < startFrame + outFrames; i++) {
  const rf = tl.refFrameForOutput(i);
  if (rf >= useFrames) break;
  comp.render(rgba, await ref.getPacked(rf), matches[rf], rf);
  for (let p = 0; p < gray.length; p++) gray[p] = rgba[p * 4];
  chunksOut.push(Buffer.from(gray));
}
writeFileSync(rawVideo, Buffer.concat(chunksOut));
lap(`${chunksOut.length} frames rendered`);
const aSlice = audio.subarray(Math.round(startAt * P.audioRate));
writeFileSync(join(outDir, 'out.f32'), Buffer.from(aSlice.buffer, aSlice.byteOffset, aSlice.byteLength));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${P.outW}x${P.outH}`, '-r', String(P.outFps), '-i', rawVideo,
  '-f', 'f32le', '-ar', String(P.audioRate), '-ac', '1', '-i', join(outDir, 'out.f32'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(outDir, 'out.mp4')]);
lap('muxed out.mp4');
// contact sheet of a few frames for eyeballing
for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  const k = Math.floor(chunksOut.length * frac);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${P.outW}x${P.outH}`, '-i', 'pipe:0', '-frames:v', '1', join(outDir, `frame-${String(Math.round(frac * 100)).padStart(2, '0')}.png`)], { input: chunksOut[k] });
}
