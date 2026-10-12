// One master timebase for video frames and audio samples. Everything derives from integers, never from timers.
export class Timeline {
  constructor({ refFps, refFrames, outFps, seconds, audioRate }) {
    this.refFps = refFps;
    this.refFrames = refFrames;
    this.outFps = outFps;
    this.audioRate = audioRate;
    this.seconds = Math.min(seconds, refFrames / refFps);
    this.frameCount = Math.max(1, Math.round(this.seconds * outFps));
    this.audioSamples = Math.round(this.seconds * audioRate);
  }

  frameTime(i) { return i / this.outFps; }

  /** Presentation timestamp in microseconds (rounded from the integer frame number, so errors never accumulate). */
  timestampMicros(i) { return Math.round((i * 1e6) / this.outFps); }

  /** Reference frame shown at output time t. */
  refFrameAt(t) { return Math.max(0, Math.min(this.refFrames - 1, Math.floor(t * this.refFps + 1e-6))); }

  refFrameForOutput(i) { return this.refFrameAt(i / this.outFps); }

  outputFrameAt(t) { return Math.max(0, Math.min(this.frameCount - 1, Math.floor(t * this.outFps + 1e-6))); }

  sampleAt(t) { return Math.round(t * this.audioRate); }

  /** Exact audio sample range that belongs to video frame i. Consecutive ranges tile the audio with no gaps. */
  audioRangeForFrame(i) {
    const a = Math.floor((i * this.audioRate) / this.outFps);
    const b = Math.min(this.audioSamples, Math.floor(((i + 1) * this.audioRate) / this.outFps));
    return [a, Math.max(a, b)];
  }
}
