/** Small audio helpers for the phone path: WAV parsing, resampling and G.711 µ-law. */

export interface Pcm {
  samples: Int16Array;
  rate: number;
}

/** Reads a 16-bit mono PCM WAV (what Gemini TTS returns). */
export function parseWav(buf: Buffer): Pcm {
  let off = 12;
  let rate = 24000;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(off + 12);
    if (id === "data") {
      const data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
      const samples = new Int16Array(data.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
      return { samples, rate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

/** Linear resampler. Good enough for speech into an 8 kHz phone line or a 16 kHz recognizer. */
export function resample(src: Int16Array, from: number, to: number): Int16Array {
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

export function linearToMulaw(s: number): number {
  const sign = s < 0 ? 0x80 : 0;
  let v = Math.min(CLIP, Math.abs(s)) + BIAS;
  let exp = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (v >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

export function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  const v = (((mant << 3) + BIAS) << exp) - BIAS;
  return sign ? -v : v;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

export function decodeMulaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

export function pcmBytes(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
