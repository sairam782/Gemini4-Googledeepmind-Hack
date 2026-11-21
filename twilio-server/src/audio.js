// Audio helpers for the phone path: G.711 µ-law, PCM16, resampling and WAV.
// Ported from the team server (server/src/audio.ts) to plain JS.

/** Linear resampler. Good enough for speech into an 8 kHz phone line or a 16 kHz recognizer. */
export function resample(src, from, to) {
  if (from === to) return src;
  const n = Math.floor((src.length * to) / from);
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    const a = src[j] ?? 0;
    const b = src[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(s) {
  const sign = s < 0 ? 0x80 : 0;
  const v = Math.min(CLIP, Math.abs(s)) + BIAS;
  let exp = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (v >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

export function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  const v = (((mant << 3) + BIAS) << exp) - BIAS;
  return sign ? -v : v;
}

/** Int16Array PCM → µ-law bytes. */
export function encodeMulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

/** µ-law bytes → Int16Array PCM. */
export function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

/** Little-endian PCM16 bytes → Int16Array. */
export function pcmFromBytes(buf) {
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Int16Array → little-endian PCM16 bytes. */
export function pcmBytes(pcm) {
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
  return out;
}

/** Reads a 16-bit mono PCM WAV. Returns { samples: Int16Array, rate }. */
export function parseWav(buf) {
  let off = 12;
  let rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      const data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
      return { samples: pcmFromBytes(data), rate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/** Wraps PCM16 mono in a WAV header. */
export function toWav(pcm, rate) {
  const data = pcmBytes(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Sample rate from a mime type like "audio/pcm;rate=24000". */
export function rateFromMime(mime, fallback) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? Number(m[1]) : fallback;
}
