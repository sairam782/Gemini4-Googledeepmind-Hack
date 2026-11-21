import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMulaw, encodeMulaw, parseWav, resample } from "../src/audio.ts";

/** Builds a minimal 16-bit mono PCM WAV buffer with an optional extra chunk before data. */
function buildWav(samples: Int16Array, rate: number, extraChunk?: { id: string; body: Buffer }): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8); // byte rate
  fmt.writeUInt16LE(2, 12); // block align
  fmt.writeUInt16LE(16, 14); // bits per sample

  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);

  const chunks: Buffer[] = [makeChunk("fmt ", fmt)];
  if (extraChunk) chunks.push(makeChunk(extraChunk.id, extraChunk.body));
  chunks.push(makeChunk("data", data));

  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}

function makeChunk(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  // RIFF chunks are padded to an even byte boundary.
  const pad = payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, payload, pad]);
}

describe("mu-law codec", () => {
  it("round-trips 16-bit PCM with small quantization error", () => {
    const samples = new Int16Array([
      0, 100, -100, 500, -500, 2000, -2000, 8000, -8000, 16000, -16000, 30000, -30000,
    ]);
    const decoded = decodeMulaw(encodeMulaw(samples));
    assert.equal(decoded.length, samples.length);

    for (let i = 0; i < samples.length; i++) {
      const orig = samples[i];
      const err = Math.abs(decoded[i] - orig);
      // G.711 mu-law is logarithmic (~3.5% max relative error plus a small floor near 0).
      const tolerance = Math.max(32, Math.abs(orig) * 0.04);
      assert.ok(
        err <= tolerance,
        `sample ${orig} decoded to ${decoded[i]} (error ${err} > tolerance ${tolerance})`,
      );
    }
  });
});

describe("resample", () => {
  it("downsamples 24000 Hz to 8000 Hz with exact 1/3 length", () => {
    const src = new Int16Array(2400);
    for (let i = 0; i < src.length; i++) src[i] = Math.round(Math.sin(i / 20) * 10000);

    const out = resample(src, 24000, 8000);
    assert.equal(out.length, 800);
    assert.equal(out[0], src[0]);
    assert.equal(out[1], src[3]);
  });

  it("returns the input untouched when sample rates match", () => {
    const src = new Int16Array([10, 20, 30]);
    assert.equal(resample(src, 8000, 8000), src);
  });
});

describe("parseWav", () => {
  it("parses sample rate and PCM samples from a constructed WAV", () => {
    const expected = new Int16Array([0, 1234, -5678, 32767, -32768]);
    // Include an odd-length metadata chunk to also exercise chunk skipping + padding.
    const wav = buildWav(expected, 16000, { id: "JUNK", body: Buffer.from("abc") });
    const parsed = parseWav(wav);

    assert.equal(parsed.rate, 16000);
    assert.deepEqual([...parsed.samples], [...expected]);
  });

  it("throws when the WAV has no data chunk", () => {
    const headerOnly = Buffer.alloc(12);
    headerOnly.write("RIFF", 0, "ascii");
    headerOnly.writeUInt32LE(4, 4);
    headerOnly.write("WAVE", 8, "ascii");
    assert.throws(() => parseWav(headerOnly), /no data chunk/);
  });
});
