// Bit packing helpers for binary silhouettes. A mask is packed row major, MSB first, into bytes.
export function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function packBits(bin) {
  const out = new Uint8Array((bin.length + 7) >> 3);
  for (let i = 0; i < bin.length; i++) if (bin[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

export function unpackBits(bytes, count, out = new Uint8Array(count)) {
  for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

/** Pack a 0/1 array into 32 bit words for fast Hamming distance. */
export function packWords(bin) {
  const out = new Uint32Array((bin.length + 31) >> 5);
  for (let i = 0; i < bin.length; i++) if (bin[i]) out[i >> 5] |= 1 << (i & 31);
  return out;
}

export function hamming(a, aOff, b, bOff, words) {
  let d = 0;
  for (let i = 0; i < words; i++) d += popcount32(a[aOff + i] ^ b[bOff + i]);
  return d;
}
