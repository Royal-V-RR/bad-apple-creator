// File selection, validation and camera recording. Camera and microphone are requested only on an explicit action.
export const LIMITS = { maxBytes: 600 * 1024 * 1024, maxAudioFileBytes: 300 * 1024 * 1024, minSeconds: 0.5, maxSeconds: 600, maxDimension: 8192, recordSeconds: 20 };

export class InputError extends Error {
  constructor(message, code = 'input') { super(message); this.code = code; }
}

export function validateFile(file) {
  if (!file) throw new InputError('No file was selected.');
  const okType = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(file.name);
  if (!okType) throw new InputError('That does not look like a video. Choose an MP4, WebM, or MOV file.', 'format');
  if (file.size === 0) throw new InputError('That file is empty.', 'format');
  if (file.size > LIMITS.maxBytes) throw new InputError(`That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${LIMITS.maxBytes / 1048576} MB. Trim the clip and try again.`, 'size');
}

export function validateVideo(video) {
  const { duration, videoWidth: w, videoHeight: h } = video;
  if (!Number.isFinite(duration)) throw new InputError('This video has no readable duration. Try recording it again or converting it to MP4.', 'decode');
  if (duration < LIMITS.minSeconds) throw new InputError('This clip is too short. Use at least half a second.', 'duration');
  if (duration > LIMITS.maxSeconds) throw new InputError(`This clip is ${Math.round(duration / 60)} minutes long. The limit is ${LIMITS.maxSeconds / 60} minutes.`, 'duration');
  if (!w || !h) throw new InputError('This browser cannot read the picture in this video. Try MP4 (H.264) or WebM.', 'decode');
  if (w > LIMITS.maxDimension || h > LIMITS.maxDimension) throw new InputError('This video is larger than 8192 pixels on one side. Use a smaller recording.', 'size');
  return { duration, width: w, height: h, orientation: h > w ? 'portrait' : 'landscape' };
}

export function pickRecorderMime() {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) || '';
}

export function cameraSupport() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return { ok: false, reason: 'This browser cannot record video.' };
  if (!window.isSecureContext) return { ok: false, reason: 'Camera access needs HTTPS. The deployed site must be served over https.' };
  return { ok: true };
}

export class CameraRecorder {
  constructor() { this.stream = null; this.rec = null; this.chunks = []; this.startedAt = 0; }

  async open(facingMode = 'user') {
    const support = cameraSupport();
    if (!support.ok) throw new InputError(support.reason, 'camera');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }, audio: { echoCancellation: false, noiseSuppression: false } });
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      throw new InputError(denied ? 'Camera or microphone permission was blocked. Allow both in the browser site settings, then try again.' : `Could not start the camera: ${err?.message || err}`, 'camera');
    }
    return this.stream;
  }

  start(onTick, maxSeconds = LIMITS.recordSeconds) {
    this.chunks = [];
    const mimeType = pickRecorderMime();
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.startedAt = performance.now();
    this.stopped = new Promise((res) => { this.rec.onstop = () => res(new Blob(this.chunks, { type: this.rec.mimeType || mimeType || 'video/webm' })); });
    this.rec.start(250);
    this.timer = setInterval(() => {
      const s = (performance.now() - this.startedAt) / 1000;
      onTick?.(s, maxSeconds);
      if (s >= maxSeconds) this.stop();
    }, 200);
  }

  async stop() {
    clearInterval(this.timer);
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    return this.stopped;
  }

  close() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
