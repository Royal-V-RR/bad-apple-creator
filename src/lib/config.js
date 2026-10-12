// Quality presets and reference geometry. Everything tunable lives here.
export const REF = {
  maskW: 128,
  maskH: 96,
  gridW: 32,
  gridH: 24,
  coarseW: 8,
  coarseH: 6,
};

export const PRESETS = {
  fast: {
    label: 'Fast',
    note: 'Small and quick. Best for phones.',
    workW: 64, workH: 48,
    maxFrames: 120,
    sampleFps: 6,
    dedupe: 0.03,
    candidates: 8,
    outW: 240, outH: 180, outFps: 15,
    audioRate: 24000,
    maxSeconds: 30,
  },
  balanced: {
    label: 'Balanced',
    note: 'Sensible default for laptops and recent phones.',
    workW: 96, workH: 72,
    maxFrames: 240,
    sampleFps: 10,
    dedupe: 0.02,
    candidates: 16,
    outW: 320, outH: 240, outFps: 24,
    audioRate: 48000,
    maxSeconds: 45,
  },
  quality: {
    label: 'Quality',
    note: 'More frames, finer silhouettes. Needs memory and patience.',
    workW: 128, workH: 96,
    maxFrames: 480,
    sampleFps: 15,
    dedupe: 0.012,
    candidates: 32,
    outW: 480, outH: 360, outFps: 30,
    audioRate: 48000,
    maxSeconds: 60,
  },
};

export const DEFAULT_SETTINGS = {
  preset: 'balanced',
  visualMode: 'silhouette',
  audioMode: 'rhythm',
  threshold: 0,
  adaptive: false,
  contrast: 1.0,
  invert: false,
  dither: 'bayer',
  pixelate: 1,
  texture: 0.7,
  temporalPenalty: 0.6,
  outputSeconds: 0,
  reuse: 1.0,
  minSeparation: 0.08,
  volume: 0.9,
  fade: 0.01,
  variation: 0.1,
  pitchShift: true,
  seed: 1,
  visualOnly: false,
};

export function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return /iPhone|iPad|iPod|Android/i.test(ua) || (coarse && (navigator.maxTouchPoints || 0) > 1);
}

export function defaultPresetName() {
  if (isLikelyMobile()) return 'fast';
  const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory || 4 : 4;
  return mem >= 8 ? 'balanced' : 'fast';
}
