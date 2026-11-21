import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.TTS_MODEL || "gemini-3.8-flash-tts";
const VOICE = process.env.TTS_VOICE || "Kore";
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
    p.catch(() => cache.delete(key)); // don't cache failures
  }
  return p;
}

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
