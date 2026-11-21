// Generates the demo video's voiceover lines and sound effects with ElevenLabs.
// Run from the repo root (reads ELEVENLABS_API_KEY from .env; the key never goes in this file):
//   node --env-file=.env demo/make-audio.mjs
// Output: demo/work/vo-*.mp3 and demo/work/sfx-*.mp3 (git-ignored); make-video.sh mixes them.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error('Set ELEVENLABS_API_KEY in .env');
const VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Sarah: mature, reassuring, confident
const OUT = 'demo/work';
mkdirSync(OUT, { recursive: true });

// Narration, one line per moment in the screen recording (see make-video.sh for timings).
export const LINES = {
  intro: 'Scam calls keep getting smarter. Uno ReVoice answers them for you.',
  flow: 'Unknown calls are forwarded to our agent. Gemini 3.8 Live talks to the caller, Gemini 4 Hydrogen flags warning signs, and Gemini 4 Neon makes the call: scam, or real.',
  call: 'You watch it live: the transcript, and every warning sign Hydrogen spots.',
  scam2: "Neon's verdict: scam. One tap blocks the number.",
  real2: 'Real callers get through. Maya agrees to a callback, so Neon says real.',
  join: 'Join or end the call anytime.',
  history: 'Every call is saved, with the verdict and the reasons.',
  outro2: 'Demo, simulation, or real forwarded calls. Uno ReVoice, powered by Gemini.',
};

const SFX = {
  notify: ['Soft modern smartphone notification chime, two gentle tones, clean, no reverb', 0.8],
  ping: ['Very subtle short UI alert ping, soft and clean', 0.5],
  alarm: ['Short low warning tone for an app alert, subtle, not scary', 0.8],
  click: ['Soft single UI button tap click', 0.5],
  success: ['Gentle positive success chime, warm, short, app UI', 0.9],
  whoosh: ['Very soft quick swipe whoosh for a screen transition', 0.5],
};

async function post(path, body) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

const have = (f) => existsSync(f);

for (const [name, text] of Object.entries(LINES)) {
  if (have(`${OUT}/vo-${name}.mp3`)) continue; // delete a file to regenerate it
  const mp3 = await post(`/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
  });
  writeFileSync(`${OUT}/vo-${name}.mp3`, mp3);
  console.log(`voice  ${name}`);
}

for (const [name, [text, seconds]] of Object.entries(SFX)) {
  if (have(`${OUT}/sfx-${name}.mp3`)) continue;
  const mp3 = await post('/v1/sound-generation', { text, duration_seconds: seconds, prompt_influence: 0.6 });
  writeFileSync(`${OUT}/sfx-${name}.mp3`, mp3);
  console.log(`sfx    ${name}`);
}
