// Landing screen animation: plays real reference silhouettes (one 10 second chunk) as 1 bit pixels.
import { loadReference } from '../pipeline.js';
import { unpackBits } from '../lib/bits.js';

export async function startHero(canvas) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ref;
  try { ref = await loadReference(); } catch { return () => {}; }
  const ctx = canvas.getContext('2d');
  canvas.width = ref.maskW; canvas.height = ref.maskH;
  const img = ctx.createImageData(ref.maskW, ref.maskH);
  const bin = new Uint8Array(ref.maskW * ref.maskH);
  const first = 900;
  await ref.loadChunk(ref.chunkOf(first));
  const draw = (f) => {
    unpackBits(ref.peekPacked(f), bin.length, bin);
    for (let i = 0; i < bin.length; i++) { const v = bin[i] ? 255 : 0; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  };
  draw(first + 120);
  if (reduce) return () => {};
  let n = 0, timer = setInterval(() => { if (!document.hidden && canvas.offsetParent) draw(first + (n = (n + 2) % 290)); }, 66);
  return () => clearInterval(timer);
}
