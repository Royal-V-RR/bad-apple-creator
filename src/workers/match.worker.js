// Visual matching in the background: streams reference chunks, scores candidates, and solves the timeline.
import { ReferenceData } from '../reference/loader.js';
import { FeatureSet } from '../matching/features.js';
import { VisualMatcher, describeMatches } from '../matching/visual-matcher.js';
import { REF } from '../lib/config.js';
import { unpackBits } from '../lib/bits.js';
import { cacheGet, cacheSet } from '../storage/cache.js';

self.onmessage = async (e) => {
  const { lib, baseUrl, totalFrames, candidates, temporalPenalty, seed } = e.data;
  try {
    const library = { count: lib.count, times: lib.times, features: FeatureSet.fromPlain(lib.features) };
    const ref = new ReferenceData({ baseUrl, maxChunks: 1, cache: { get: cacheGet, set: cacheSet } });
    await ref.init();
    const frames = Math.min(totalFrames, ref.frames);
    const matcher = new VisualMatcher(library, { totalFrames: frames, candidates, temporalPenalty, seed });
    const bin = new Uint8Array(REF.maskW * REF.maskH);
    let done = 0;
    for (let c = 0; done < frames; c++) {
      const raw = await ref.loadChunk(c);
      const count = Math.min(ref.manifest.chunks[c].count, frames - done);
      const set = new FeatureSet(count);
      for (let f = 0; f < count; f++) {
        unpackBits(raw.subarray(f * ref.bytesPerFrame, (f + 1) * ref.bytesPerFrame), bin.length, bin);
        set.setFromBinary(f, bin, REF.maskW, REF.maskH);
      }
      matcher.addReference(set, count);
      done += count;
      self.postMessage({ type: 'progress', value: (done / frames) * 0.9 });
    }
    const matches = matcher.solve();
    self.postMessage({ type: 'progress', value: 1 });
    self.postMessage({ type: 'done', matches, stats: { ...describeMatches(matches, library.count), ...matcher.stats } }, [matches.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
