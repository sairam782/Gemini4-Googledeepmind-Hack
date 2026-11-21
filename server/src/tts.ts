import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.TTS_MODEL || "gemini-3.8-flash-tts";
const VOICE = process.env.TTS_VOICE || "Sulafat"; // see scripts/check-tone.ts
const SAMPLE_RATE = 24000; // default rate when the model returns raw 16-bit PCM

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const cache = new Map<string, Promise<Buffer>>();

export const ttsEnabled = () => ai !== null;

/** Render `text` to a WAV buffer. Cached by voice + text, so pre-renders are reused on tap. */
export function renderSpeech(text: string, voice = VOICE): Promise<Buffer> {
  if (!ai) return Promise.reject(new Error("GEMINI_API_KEY is not set"));
  const key = `${voice}\u0000${text}`;
  let p = cache.get(key);
  if (!p) {
    p = synth(text, voice);
    cache.set(key, p);
    p.then((wav) => wav.readUInt32LE(24) === SAMPLE_RATE && wav.readUInt32LE(36) === 0x61746164 && done.set(key, wav)).catch(() => {});
    p.catch(() => cache.delete(key)); // don't cache failures
  }
  return p;
}

const done = new Map<string, Buffer>(); // finished renders, so a stream request can answer at once

/**
 * Streams raw 16-bit PCM at `SAMPLE_RATE` as the model produces it: first audio in ~0.8 s instead of
 * 3-5 s for the whole clip. The finished clip lands in the cache, so a later replay is instant.
 */
export async function streamSpeech(text: string, voice = VOICE, onPcm: (pcm: Buffer) => void): Promise<void> {
  if (!ai) throw new Error("GEMINI_API_KEY is not set");
  const key = `${voice}\u0000${text}`;
  const ready = done.get(key);
  if (ready) return onPcm(ready.subarray(44));
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text }] }],
    config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  const parts: Buffer[] = [];
  for await (const c of stream) {
    const inline = c.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) continue;
    let pcm = Buffer.from(inline.data, "base64");
    if (pcm.subarray(0, 4).toString() === "RIFF") pcm = pcm.subarray(44);
    parts.push(pcm);
    onPcm(pcm);
  }
  if (!parts.length) throw new Error("TTS returned no audio");
  const wav = pcmToWav(Buffer.concat(parts), SAMPLE_RATE);
  done.set(key, wav);
  if (!cache.has(key)) cache.set(key, Promise.resolve(wav));
}

export const STREAM_RATE = SAMPLE_RATE;

async function synth(text: string, voice: string): Promise<Buffer> {
  const res = await ai!.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("TTS returned no audio");
  const bytes = Buffer.from(inline.data, "base64");
  // 3.8 TTS returns a complete WAV; 3.1 returns raw PCM ("audio/l16; rate=24000").
  if (bytes.subarray(0, 4).toString() === "RIFF") return bytes;
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1]) || SAMPLE_RATE;
  return pcmToWav(bytes, rate);
}

function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
