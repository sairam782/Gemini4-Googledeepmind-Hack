// Test the phone path without a phone: streams a caller into WS /media the way SignalWire does
// (connected → start → 20 ms µ-law media frames → stop), listens to the app events on WS /app,
// and saves what the agent said to sim-agent.wav.
//
//   npm run sim                      # built-in scam caller, voiced with macOS `say`
//   npm run sim -- --wav caller.wav  # your own recording (16-bit mono WAV, any rate)
//   npm run sim -- --url ws://localhost:3000 --gap 7

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { decodeMulaw, encodeMulaw, parseWav, resample, toWav } from '../src/audio.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('url', `ws://localhost:${process.env.PORT || 3000}`);
const GAP_S = Number(arg('gap', 7)); // silence after each caller line, so the agent can answer

const SCAM_LINES = [
  "Hi, it's me, your granddaughter. I lost my phone, I'm calling from a friend's.",
  "I was in a car accident and I'm stuck. I need nine hundred dollars right now for the tow.",
  'Can you send it with gift cards? Please hurry, and please don\'t tell Mom.',
  "No, don't call me back, this phone is dying. I need it in the next ten minutes.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Caller audio as 8 kHz PCM: a WAV file, or each scripted line voiced by macOS `say` with silence between. */
function callerAudio() {
  const wav = arg('wav');
  if (wav) {
    const { samples, rate } = parseWav(readFileSync(wav));
    return [resample(samples, rate, 8000)];
  }
  const dir = mkdtempSync(join(tmpdir(), 'revoice-sim-'));
  return SCAM_LINES.map((text, i) => {
    const out = join(dir, `line${i}.wav`);
    execFileSync('say', ['-o', out, '--data-format=LEI16@8000', text]);
    return parseWav(readFileSync(out)).samples;
  });
}

const lines = callerAudio();
const callId = `SIM-${Date.now()}`;
const agentPcm = [];

// Watch what the phone app would see.
const app = new WebSocket(`${BASE}/app`);
app.on('message', (raw) => {
  const e = JSON.parse(String(raw));
  if (e.callId !== callId) return;
  const detail = e.type === 'transcript' ? `${e.speaker}: ${e.text}` : e.type === 'signal' ? e.label : e.type === 'verdict' ? `${e.verdict} (${e.reasons.join('; ')})` : e.from ?? '';
  console.log(`[app] ${e.type.padEnd(12)} ${detail}`);
  if (e.type === 'call.ended') {
    writeFileSync('sim-agent.wav', toWav(resample(Int16Array.from(agentPcm.flatMap((a) => [...a])), 8000, 8000), 8000));
    console.log('Saved the agent audio to sim-agent.wav');
    setTimeout(() => process.exit(0), 300);
  }
});

const media = new WebSocket(`${BASE}/media`);
media.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event === 'media') agentPcm.push(decodeMulaw(Buffer.from(m.media.payload, 'base64')));
  if (m.event === 'clear') console.log('[line] clear (caller interrupted the agent)');
});

media.on('open', async () => {
  const streamSid = `MZ${Date.now()}`;
  const send = (m) => media.send(JSON.stringify(m));
  send({ event: 'connected', protocol: 'Call', version: '0.2.0' });
  send({
    event: 'start',
    sequenceNumber: '1',
    start: {
      streamSid,
      accountSid: 'sim',
      callSid: callId,
      tracks: ['inbound'],
      customParameters: { callId, from: '+15550100199' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
  console.log(`[sim] call ${callId} started; streaming ${lines.length} caller line(s)`);

  const frame = 160;
  const silence = new Int16Array(frame);
  const sendFrame = (pcm) => send({ event: 'media', media: { track: 'inbound', payload: encodeMulaw(pcm).toString('base64') } });

  await sleep(4000); // let the agent greet first
  for (const pcm of lines) {
    for (let i = 0; i < pcm.length; i += frame) {
      sendFrame(pcm.subarray(i, i + frame));
      await sleep(20);
    }
    // Silence keeps flowing, like a real line, while the agent answers.
    for (let t = 0; t < GAP_S * 50; t++) {
      sendFrame(silence);
      await sleep(20);
    }
  }
  send({ event: 'stop', sequenceNumber: '999' });
  media.close();
  console.log('[sim] caller hung up; waiting for the verdict…');
  setTimeout(() => process.exit(0), 30_000);
});

media.on('error', (e) => {
  console.error(`Can't reach ${BASE}/media: ${e.message}. Is the server running (npm start)?`);
  process.exit(1);
});
