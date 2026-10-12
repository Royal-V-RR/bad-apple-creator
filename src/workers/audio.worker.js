// Audio work in the background: sample extraction and analysis, then planning and chunked mixing.
import { buildSampleLibrary } from '../media/audio-analysis.js';
import { planAudio, AudioRenderer } from '../render/audio-mixer.js';

let stop = false;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.task === 'analyze') {
      const { samples, fallback } = buildSampleLibrary(m.mono, m.sampleRate, m.outRate);
      const transfer = samples.map((s) => s.pcm.buffer);
      self.postMessage({ type: 'done', samples, fallback }, transfer);
    } else if (m.task === 'mix') {
      const { plan, stats } = planAudio(m.events, m.samples, m.settings, m.seconds);
      const renderer = new AudioRenderer({ plan, samples: m.samples, sampleRate: m.sampleRate, totalSamples: m.totalSamples, settings: m.settings });
      const audio = await renderer.renderAll((v) => self.postMessage({ type: 'progress', value: v }), () => stop);
      self.postMessage({ type: 'done', audio, planned: plan.length, stats }, [audio.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
