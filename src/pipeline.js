// Orchestrates the eight real processing stages. Each stage reports progress from work actually completed.
import { ReferenceData } from './reference/loader.js';
import { cacheGet, cacheSet } from './storage/cache.js';
import { PRESETS } from './lib/config.js';
import { loadVideoElement, planSampleTimes, extractFrames, buildLibrary, libraryLevels } from './media/video-analysis.js';
import { decodeAudio, hasUsableAudio } from './media/audio-analysis.js';
import { validateFile, validateVideo, LIMITS, InputError } from './media/input.js';
import { Timeline } from './render/timeline.js';
import { Compositor } from './render/compositor.js';
import { runWorker } from './workers/client.js';

export const STAGES = [
  { id: 'read', label: 'Reading the video' },
  { id: 'frames', label: 'Extracting frames' },
  { id: 'audio', label: 'Analyzing recorded audio' },
  { id: 'tiles', label: 'Building the visual tile library' },
  { id: 'sounds', label: 'Building the sound library' },
  { id: 'match', label: 'Matching the reference timeline' },
  { id: 'render', label: 'Rendering the reconstruction' },
  { id: 'encode', label: 'Encoding the final video' },
];

const makeMatchWorker = () => new Worker(new URL('./workers/match.worker.js', import.meta.url), { type: 'module' });
const makeAudioWorker = () => new Worker(new URL('./workers/audio.worker.js', import.meta.url), { type: 'module' });
const cacheApi = { get: cacheGet, set: cacheSet };

export function referenceBase() {
  return new URL('reference/', document.baseURI).href;
}

export async function loadReference() {
  const ref = new ReferenceData({ baseUrl: referenceBase(), cache: cacheApi });
  await ref.init();
  return ref;
}

export function estimate(duration, settings) {
  const p = PRESETS[settings.preset];
  const frames = planSampleTimes(duration, p.sampleFps, p.maxFrames).length;
  const seconds = settings.outputSeconds || 219.07;
  const outFrames = Math.round(Math.min(seconds, 219.07) * p.outFps);
  const memoryMB = Math.round((frames * p.workW * p.workH * 1.3) / 1e6 + (Math.min(seconds, 219.07) * p.audioRate * 4) / 1e6 + 60);
  const deviceGB = navigator.deviceMemory || 4;
  const warnings = [];
  if (duration > p.maxSeconds) warnings.push(`This clip is ${Math.round(duration)} seconds long. Frames are sampled evenly, so you lose no coverage but some detail.`);
  if (memoryMB > deviceGB * 1024 * 0.25) warnings.push('This setting may use more memory than your device can spare. Choose Fast if the tab reloads.');
  if (settings.preset === 'quality' && /iPhone|iPad|Android/i.test(navigator.userAgent)) warnings.push('Quality mode is heavy for phones. Fast or Balanced is safer.');
  return { frames, outFrames, memoryMB, warnings };
}

export class Session {
  constructor(file) {
    this.file = file;
    this.url = URL.createObjectURL(file);
    this.video = null;
    this.meta = null;
    this.frameKey = null;
    this.frames = null;
    this.times = null;
    this.audioChecked = false;
    this.mono = null;
    this.audioInfo = { present: false, reason: '' };
    this.samplesKey = null;
    this.samples = null;
    this.ref = null;
    this.events = null;
  }

  async open({ report } = {}) {
    report?.('read', { state: 'active', fraction: 0 });
    validateFile(this.file);
    try {
      this.video = await loadVideoElement(this.url);
    } catch {
      throw new InputError('This browser cannot decode that video. Try an MP4 (H.264) or WebM file, or record one in the app.', 'decode');
    }
    this.meta = validateVideo(this.video);
    report?.('read', { state: 'done', fraction: 1, detail: `${this.meta.width}x${this.meta.height}, ${this.meta.duration.toFixed(1)} s, ${this.meta.orientation}` });
    return this.meta;
  }

  async build(settings, { report = () => {}, signal } = {}) {
    const t0 = performance.now();
    const timings = {};
    const lap = (k, t) => { timings[k] = Math.round(performance.now() - t); };
    const preset = PRESETS[settings.preset];
    const stat = {};

    // Stage 2: frames
    const key = `${preset.workW}x${preset.workH}:${preset.maxFrames}:${preset.sampleFps}`;
    if (this.frameKey !== key) {
      const s = performance.now();
      report('frames', { state: 'active', fraction: 0 });
      const times = planSampleTimes(this.meta.duration, preset.sampleFps, preset.maxFrames);
      this.frames = await extractFrames(this.video, { workW: preset.workW, workH: preset.workH, times, signal, onProgress: (f) => report('frames', { state: 'active', fraction: f, detail: `${Math.round(f * times.length)} of ${times.length}` }) });
      this.times = times;
      this.frameKey = key;
      lap('frames', s);
    }
    report('frames', { state: 'done', fraction: 1, detail: `${this.frames.length} frames kept` });

    // Stage 3: audio decode
    if (settings.visualOnly) {
      report('audio', { state: 'skipped', detail: 'Visual only' });
    } else {
      if (!this.audioChecked) {
        const s = performance.now();
        report('audio', { state: 'active', fraction: 0 });
        this.audioChecked = true;
        if (this.file.size > LIMITS.maxAudioFileBytes) this.audioInfo = { present: false, reason: 'The file is too large to read the audio on this device.' };
        else {
          try {
            const { mono, sampleRate } = await decodeAudio(await this.file.arrayBuffer());
            if (hasUsableAudio(mono)) { this.mono = { mono, sampleRate }; this.audioInfo = { present: true }; }
            else this.audioInfo = { present: false, reason: 'No sound was found in this recording.' };
          } catch {
            this.audioInfo = { present: false, reason: 'This browser could not read the audio track.' };
          }
        }
        lap('audioDecode', s);
      }
      report('audio', this.audioInfo.present ? { state: 'done', fraction: 1, detail: `${(this.mono?.mono.length / this.mono?.sampleRate || this.meta.duration).toFixed(1)} s of audio` } : { state: 'skipped', detail: this.audioInfo.reason });
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const useAudio = !settings.visualOnly && (this.audioInfo.present);

    // Stage 4: tile library
    report('tiles', { state: 'active', fraction: 0 });
    let s = performance.now();
    await new Promise((r) => setTimeout(r, 0));
    const lib = buildLibrary(this.frames, this.times, { w: preset.workW, h: preset.workH, threshold: settings.threshold, adaptive: settings.adaptive, contrast: settings.contrast, invert: settings.invert, dedupe: preset.dedupe });
    const levels = libraryLevels(lib);
    lap('tiles', s);
    stat.sourceFrames = this.frames.length; stat.libraryFrames = lib.count; stat.duplicatesRemoved = lib.removed;
    report('tiles', { state: 'done', fraction: 1, detail: `${lib.count} tiles, ${lib.removed} duplicates removed` });

    // Stage 5: sound library
    if (useAudio) {
      const sKey = `${preset.audioRate}`;
      if (this.samplesKey !== sKey) {
        s = performance.now();
        report('sounds', { state: 'active', fraction: 0 });
        const mono = this.mono.mono.slice();
        const res = await runWorker(makeAudioWorker, { task: 'analyze', mono, sampleRate: this.mono.sampleRate, outRate: preset.audioRate }, { transfer: [mono.buffer], signal });
        this.samples = res.samples; this.samplesFallback = res.fallback; this.samplesKey = sKey;
        this.mono = null;       // the decoded recording is no longer needed once the library exists
        lap('sounds', s);
      }
      if (!this.samples.length) { this.audioInfo = { present: false, reason: 'No separate sounds could be found in the recording.' }; }
      report('sounds', this.samples.length ? { state: 'done', fraction: 1, detail: `${this.samples.length} sounds${this.samplesFallback ? ' (even slices, no clear events)' : ''}` } : { state: 'skipped', detail: this.audioInfo.reason });
    } else report('sounds', { state: 'skipped', detail: settings.visualOnly ? 'Visual only' : this.audioInfo.reason });
    const hasSounds = useAudio && this.samples?.length > 0;
    stat.sounds = hasSounds ? this.samples.length : 0;

    // Stage 6: match
    if (!this.ref) this.ref = await loadReference();
    const ref = this.ref;
    const seconds = Math.min(settings.outputSeconds || ref.duration, ref.duration);
    const timeline = new Timeline({ refFps: ref.fps, refFrames: ref.frames, outFps: preset.outFps, seconds, audioRate: preset.audioRate });
    const totalFrames = Math.min(ref.frames, Math.ceil(timeline.seconds * ref.fps));
    s = performance.now();
    report('match', { state: 'active', fraction: 0 });
    const m = await runWorker(makeMatchWorker, { lib: { count: lib.count, times: lib.times, features: lib.features.toPlain() }, baseUrl: referenceBase(), totalFrames, candidates: preset.candidates, temporalPenalty: settings.temporalPenalty, seed: settings.seed }, { signal, onProgress: (v) => report('match', { state: 'active', fraction: v }) });
    lap('match', s);
    stat.visual = m.stats;
    report('match', { state: 'done', fraction: 1, detail: `${m.stats.distinctUsed} of ${lib.count} tiles used, ${m.stats.switches} switches` });

    // Stage 7: render audio (visual frames are rendered on demand by the preview and the exporter)
    report('render', { state: 'active', fraction: 0 });
    s = performance.now();
    let audio = null;
    if (hasSounds) {
      if (!this.events) this.events = await ref.loadAudioEvents();
      const res = await runWorker(makeAudioWorker, { task: 'mix', events: this.events, samples: this.samples.map((x) => ({ ...x, pcm: x.pcm.slice() })), settings: { ...settings }, seconds: timeline.seconds, sampleRate: preset.audioRate, totalSamples: timeline.audioSamples }, { signal, onProgress: (v) => report('render', { state: 'active', fraction: v * 0.9 }) });
      audio = res.audio; stat.audio = { events: res.planned, ...res.stats };
    }
    const compositor = new Compositor({ outW: preset.outW, outH: preset.outH, maskW: ref.maskW, maskH: ref.maskH, lib, levels, settings });
    await ref.getPacked(0);
    lap('render', s);
    report('render', { state: 'done', fraction: 1, detail: audio ? `${timeline.frameCount} frames and ${(audio.length / preset.audioRate).toFixed(0)} s of audio ready` : `${timeline.frameCount} frames ready, no audio` });

    const matches = m.matches;
    /**
     * A render plan ties one Timeline to a frame renderer. The preview uses the default plan; the exporter may ask
     * for a smaller size, a lower frame rate, or a shorter clip, which is how a failed export is retried.
     */
    const makePlan = ({ scale = 1, fps = preset.outFps, secs = timeline.seconds } = {}) => {
      const tl = secs === timeline.seconds && fps === preset.outFps ? timeline
        : new Timeline({ refFps: ref.fps, refFrames: ref.frames, outFps: fps, seconds: secs, audioRate: preset.audioRate });
      const w = Math.max(2, 2 * Math.round((preset.outW * scale) / 2)), h = Math.max(2, 2 * Math.round((preset.outH * scale) / 2));
      const comp = scale === 1 ? compositor : new Compositor({ outW: w, outH: h, maskW: ref.maskW, maskH: ref.maskH, lib, levels, settings });
      const renderFrame = async (i, rgba) => {
        const rf = Math.min(matches.length - 1, tl.refFrameForOutput(i));
        const packed = ref.peekPacked(rf) ?? (await ref.getPacked(rf));
        comp.render(rgba, packed, matches[rf], rf);
      };
      return { timeline: tl, renderFrame, width: w, height: h, audio: audio ? audio.subarray(0, tl.audioSamples) : null };
    };
    const base = makePlan();
    timings.total = Math.round(performance.now() - t0);
    return { timeline, preset, settings: { ...settings }, lib, matches, audio, renderFrame: base.renderFrame, makePlan, ref, width: preset.outW, height: preset.outH, stats: stat, timings };
  }

  dispose() {
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.video) { this.video.removeAttribute('src'); this.video.load(); }
    Object.assign(this, { url: null, video: null, frames: null, mono: null, samples: null, file: null });
  }
}
