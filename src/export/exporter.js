// Final video export. The engine (Mediabunny on top of WebCodecs) is loaded lazily, only when encoding starts.
// Frames and audio are encoded incrementally from the shared Timeline, so nothing is retained in full.
// If WebCodecs is missing, a real time MediaRecorder fallback is used. Media never leaves the device.

export class ExportError extends Error {
  constructor(message, { code = 'export', hint = '' } = {}) { super(message); this.code = code; this.hint = hint; }
}

const CHOICES = [
  { container: 'mp4', video: 'avc', audio: 'aac', mime: 'video/mp4', ext: 'mp4' },
  { container: 'webm', video: 'vp9', audio: 'opus', mime: 'video/webm', ext: 'webm' },
  { container: 'webm', video: 'vp8', audio: 'opus', mime: 'video/webm', ext: 'webm' },
];

export const videoBitrate = (w, h, fps) => Math.round(Math.max(800_000, w * h * fps * 0.4));

/** Report what this browser can export, without loading the heavy engine. */
export async function probeExport({ width, height, fps, hasAudio, audioRate }) {
  if (typeof VideoEncoder === 'undefined') return { engine: 'mediarecorder', choice: null };
  const mb = await import('mediabunny');
  const bitrate = videoBitrate(width, height, fps);
  for (const c of CHOICES) {
    const v = await mb.canEncodeVideo(c.video, { width, height, bitrate, frameRate: fps }).catch(() => false);
    if (!v) continue;
    if (hasAudio && !(await mb.canEncodeAudio(c.audio, { numberOfChannels: 1, sampleRate: audioRate, bitrate: 96_000 }).catch(() => false))) continue;
    return { engine: 'webcodecs', choice: c, mb };
  }
  return { engine: typeof MediaRecorder !== 'undefined' ? 'mediarecorder' : 'none', choice: null };
}

const abortIf = (signal) => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param o.timeline  master Timeline
 * @param o.renderFrame (i, rgba: Uint8ClampedArray) => Promise|void   fills rgba for output frame i
 * @param o.audio     Float32Array mono at timeline.audioRate, or null
 */
export async function exportVideo({ timeline, renderFrame, audio, width, height, onProgress, signal }) {
  const fps = timeline.outFps, sr = timeline.audioRate;
  const probe = await probeExport({ width, height, fps, hasAudio: !!audio, audioRate: sr });
  if (probe.engine === 'webcodecs') return exportWebCodecs({ ...probe, timeline, renderFrame, audio, width, height, onProgress, signal });
  if (probe.engine === 'mediarecorder') return exportMediaRecorder({ timeline, renderFrame, audio, width, height, onProgress, signal });
  throw new ExportError('This browser cannot encode video.', { code: 'unsupported', hint: 'Try a recent version of Chrome, Edge, Safari, or Firefox.' });
}

async function exportWebCodecs({ mb, choice, timeline, renderFrame, audio, width, height, onProgress, signal }) {
  const fps = timeline.outFps, sr = timeline.audioRate;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const format = choice.container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
  const output = new mb.Output({ format, target: new mb.BufferTarget() });
  const videoSource = new mb.CanvasSource(canvas, { codec: choice.video, bitrate: videoBitrate(width, height, fps), keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (audio) {
    audioSource = new mb.AudioSampleSource({ codec: choice.audio, bitrate: 96_000 });
    output.addAudioTrack(audioSource);
  }
  try {
    await output.start();
    for (let i = 0; i < timeline.frameCount; i++) {
      abortIf(signal);
      await renderFrame(i, image.data);
      ctx.putImageData(image, 0, 0);
      await videoSource.add(i / fps, 1 / fps);
      if (audioSource) {
        // Exactly the audio that belongs to this frame, so video and sound share one clock and cannot drift.
        const [a, b] = timeline.audioRangeForFrame(i);
        if (b > a) {
          const s = new mb.AudioSample({ data: audio.slice(a, b), format: 'f32-planar', numberOfChannels: 1, sampleRate: sr, timestamp: a / sr });
          await audioSource.add(s);
          s.close();
        }
      }
      if (i % 8 === 0) { onProgress?.((i + 1) / timeline.frameCount); await tick(); }
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    if (err?.name === 'AbortError') throw err;
    throw new ExportError(`Encoding failed: ${err?.message || err}`, { code: 'encode', hint: 'Lower the resolution, frame rate, or duration and try again.' });
  }
  const buffer = output.target.buffer;
  return { blob: new Blob([buffer], { type: choice.mime }), ext: choice.ext, mime: choice.mime, engine: `WebCodecs ${choice.video}${audio ? ' + ' + choice.audio : ''}`, realtime: false };
}

/** Fallback for browsers without WebCodecs. Runs in real time because MediaRecorder only records playback. */
async function exportMediaRecorder({ timeline, renderFrame, audio, width, height, onProgress, signal }) {
  const fps = timeline.outFps, sr = timeline.audioRate;
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported?.(t));
  if (!mime) throw new ExportError('No supported recording format in this browser.', { code: 'unsupported', hint: 'Use a recent Chrome, Edge, Safari, or Firefox.' });
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const stream = canvas.captureStream(fps);
  let actx = null, src = null;
  if (audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC({ sampleRate: sr });
    const dest = actx.createMediaStreamDestination();
    const buf = actx.createBuffer(1, audio.length, sr);
    buf.copyToChannel(audio, 0);
    src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBitrate(width, height, fps) });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((res, rej) => { rec.onstop = res; rec.onerror = (e) => rej(e.error || new Error('Recorder error')); });
  await renderFrame(0, image.data); ctx.putImageData(image, 0, 0);
  rec.start(1000);
  const clock = () => (actx ? actx.currentTime : performance.now() / 1000);
  const t0 = clock();
  src?.start();
  let last = -1;
  try {
    while (true) {
      abortIf(signal);
      const t = clock() - t0;
      if (t >= timeline.seconds) break;
      const f = Math.min(timeline.frameCount - 1, Math.floor(t * fps));
      if (f !== last) { await renderFrame(f, image.data); ctx.putImageData(image, 0, 0); last = f; }
      onProgress?.(t / timeline.seconds);
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    rec.state !== 'inactive' && rec.stop();
    src?.stop?.();
    actx?.close?.();
  }
  await done;
  const type = mime.split(';')[0];
  return { blob: new Blob(parts, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', mime: type, engine: 'MediaRecorder (real time)', realtime: true };
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Bad Apple!! reconstruction' }); return true; }
  return false;
}
