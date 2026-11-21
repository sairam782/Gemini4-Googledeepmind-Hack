// Tone check for the agent's voice: render real agent lines in candidate Gemini TTS voices, then have
// Gemini listen to each clip and score it. TTS style prompts ("Say calmly: ...") are read aloud by
// gemini-3.8-flash-tts, so tone comes from the voice choice; this picks it with evidence.
//   npx tsx --env-file=../.env scripts/check-tone.ts [Kore,Sulafat,...]
import { GoogleGenAI } from "@google/genai";
import { renderSpeech } from "../src/tts.ts";
import { parseWav } from "../src/audio.ts";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const JUDGE = process.env.TONE_JUDGE_MODEL || "gemini-3.8-flash";
const voices = (process.argv[2] ?? "Kore,Sulafat,Achird,Vindemiatrix,Aoede").split(",");
const LINES = [
  "Hi, this is Alex's AI assistant. Alex is listening in.",
  "I hear it's urgent. Since you weren't sure, Alex will call Maya on the number Alex has saved for her.",
  "Alex won't send the $900 to Jordan on this call.",
  "Got it, Tuesday at 10. I'll pass that to Alex. Thanks for calling!",
];

interface Score { calm: number; warm: number; clear: number; trustworthy: number; rushed: boolean; misread: boolean; note: string }

async function judge(wav: Buffer, line: string): Promise<Score> {
  const res = await ai.models.generateContent({
    model: JUDGE,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: `This is an AI phone assistant speaking to a caller who may be a scammer or a real person. The intended words are: "${line}".
Rate the VOICE (not the words) 1-5 for: calm, warm, clear, trustworthy. "rushed": true if it sounds hurried. "misread": true if the spoken words differ from the intended words. "note": 6 words on the tone.
JSON only: {"calm":0,"warm":0,"clear":0,"trustworthy":0,"rushed":false,"misread":false,"note":""}` },
    ] }],
    config: { responseMimeType: "application/json" },
  });
  return JSON.parse(res.text ?? "{}") as Score;
}

const rows: { voice: string; avg: number; secs: number; flags: string; notes: string }[] = [];
for (const voice of voices) {
  const scores: Score[] = [];
  let secs = 0;
  for (const line of LINES) {
    try {
      const wav = await renderSpeech(line, voice);
      const { samples, rate } = parseWav(wav);
      secs += samples.length / rate;
      scores.push(await judge(wav, line));
    } catch (e) {
      console.log(`${voice}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  if (!scores.length) continue;
  const avg = scores.reduce((a, s) => a + (s.calm + s.warm + s.clear + s.trustworthy) / 4, 0) / scores.length;
  const flags = [scores.some((s) => s.rushed) && "rushed", scores.some((s) => s.misread) && "misread"].filter(Boolean).join(",");
  rows.push({ voice, avg, secs, flags, notes: scores.map((s) => s.note).join(" / ") });
}
rows.sort((a, b) => b.avg - a.avg);
for (const r of rows) console.log(`${r.voice.padEnd(13)} tone ${r.avg.toFixed(2)}/5  ${r.secs.toFixed(1)}s total  ${r.flags || "ok"}  — ${r.notes}`);
process.exit(0);
