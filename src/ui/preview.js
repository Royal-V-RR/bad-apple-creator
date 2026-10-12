// Playback of the generated result. One clock (audio context time when there is sound) drives frame selection,
// so seeking and pausing never need a re-match.
export class Preview {
  constructor({ canvas, result, onTime, onEnd }) {
    this.canvas = canvas;
    this.result = result;
    this.tl = result.timeline;
    canvas.width = result.width; canvas.height = result.height;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(result.width, result.height);
    this.onTime = onTime; this.onEnd = onEnd;
    this.playing = false; this.offset = 0; this.startedAt = 0;
    this.actx = null; this.source = null; this.buffer = null;
    this.last = -1; this.busy = false; this.raf = 0; this.dead = false;
    this.renderAt(0);
  }

  clock() { return this.actx && this.result.audio ? this.actx.currentTime : performance.now() / 1000; }
  get time() { return Math.min(this.tl.seconds, this.playing ? this.offset + (this.clock() - this.startedAt) : this.offset); }

  async renderAt(t) {
    const f = this.tl.outputFrameAt(t);
    if (f === this.last || this.busy) return;
    this.busy = true;
    try {
      await this.result.renderFrame(f, this.image.data);
      if (!this.dead) { this.ctx.putImageData(this.image, 0, 0); this.last = f; }
      const ci = this.result.ref.chunkOf(this.tl.refFrameForOutput(f));
      if (ci + 1 < this.result.ref.manifest.chunks.length) this.result.ref.loadChunk(ci + 1).catch(() => {});
    } finally { this.busy = false; }
  }

  startSource() {
    if (!this.result.audio) return;
    if (!this.actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.actx = new AC({ sampleRate: this.tl.audioRate });
      this.buffer = this.actx.createBuffer(1, this.result.audio.length, this.tl.audioRate);
      this.buffer.copyToChannel(this.result.audio, 0);
    }
    this.source = this.actx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.actx.destination);
    this.source.start(0, this.offset);
  }

  stopSource() { try { this.source?.stop(); } catch { /* already stopped */ } this.source?.disconnect(); this.source = null; }

  async play() {
    if (this.playing) return;
    if (this.offset >= this.tl.seconds - 0.05) this.offset = 0;
    if (this.result.audio) { await this.startCtx(); }
    this.startSource();
    this.startedAt = this.clock();
    this.playing = true;
    const loop = () => {
      if (this.dead || !this.playing) return;
      const t = this.time;
      this.renderAt(t);
      this.onTime?.(t);
      if (t >= this.tl.seconds) { this.pause(); this.offset = 0; this.onEnd?.(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async startCtx() {
    if (!this.actx) { this.startSource(); this.stopSource(); }
    await this.actx.resume?.();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopSource();
  }

  async seek(t) {
    const was = this.playing;
    this.pause();
    this.offset = Math.max(0, Math.min(this.tl.seconds, t));
    this.last = -1;
    await this.renderAt(this.offset);
    this.onTime?.(this.offset);
    if (was) await this.play();
  }

  destroy() {
    this.dead = true;
    this.pause();
    this.actx?.close?.();
    this.actx = null; this.buffer = null;
  }
}
