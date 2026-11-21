// End-to-end test of desk mic mode without a microphone: speaks caller lines with Gemini TTS, streams the
// audio at real-time pace as 16 kHz PCM over the desk socket (exactly what the browser mic sends), hands the
// call to the agent, and prints what was transcribed and what the agent said back.
//   npx tsx --env-file=../.env scripts/sim-mic.ts [scenarioId] [ws://localhost:8787/ws]
import WebSocket from "ws";
import type { DeskServerMsg } from "../../shared/brain.ts";
import { renderSpeech } from "../src/tts.ts";
import { parseWav, pcmBytes, resample } from "../src/audio.ts";

const scenario = process.argv[2] ?? "maya";
const url = process.argv[3] ?? `ws://localhost:${process.env.API_PORT || 8787}/ws`;
const LINES: Record<string, string[]> = {
  maya: [
    "Hey, it's Maya. My phone broke, I'm calling from a friend's phone.",
    "I was in a car accident, I'm okay but I need nine hundred dollars for the tow right now.",
    "Please, no time for questions, just send it to my friend Jordan on Venmo.",
  ],
  pharmacy: ["Hi, this is the pharmacy on Fifth Avenue. A prescription for Alex is ready for pickup.", "We'll hold it for seven days. Thanks, bye!"],
};
const lines = LINES[scenario] ?? LINES.maya;
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const ws = new WebSocket(url);
let revision = 1;
let agentBusy = false;
let delegated = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stoppedAt = 0; // when the last line's speech ended, to time the reply
async function speak(text: string) {
  const { samples, rate } = parseWav(await renderSpeech(text, "Puck"));
  const pcm = pcmBytes(resample(samples, rate, 16000));
  const chunk = 16000 * 2 * 0.1; // 100 ms frames, real time
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.subarray(i, i + chunk));
    await sleep(100);
  }
  stoppedAt = Date.now();
  console.log(`${ts()}   (stopped talking)`);
  const silence = Buffer.alloc(chunk);
  for (let i = 0; i < 12; i++) { ws.send(silence); await sleep(100); } // 1.2 s of silence ends the turn
}

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw)) as DeskServerMsg;
  if (m.type === "state") revision = m.revision;
  if (m.type === "turn.final") console.log(`${ts()} ${m.turn.speaker.padEnd(6)} ${m.turn.text}`);
  if (m.type === "agent.say") { agentBusy = true; console.log(`${ts()}   >> agent says${m.auto ? " (auto)" : ""}${stoppedAt ? `  [${((Date.now() - stoppedAt) / 1000).toFixed(1)} s after you stopped]` : ""}`); setTimeout(() => { agentBusy = false; ws.send(JSON.stringify({ type: "desk.agentDone", turnId: m.turnId })); }, 600 + m.text.split(" ").length * 330); }
  if (m.type === "risk.level") console.log(`${ts()}   LEVEL ${m.risk.level}${m.risk.locked ? " LOCKED" : ""}`);
  if (m.type === "error") console.log(`${ts()}   ERROR ${m.message}`);
  if (m.type === "call.review") { console.log(`${ts()}   REVIEW ${m.review.verdict}: ${m.review.evals.filter((e) => e.pass).length}/${m.review.evals.length} evals`); m.review.evals.filter((e) => !e.pass).forEach((e) => console.log(`      FAIL ${e.name}: ${e.detail}`)); process.exit(0); }
  if (m.type === "turn.final" && m.turn.speaker === "caller" && !delegated) {
    delegated = true;
    ws.send(JSON.stringify({ type: "control.delegate", actionId: `sim-${Date.now()}`, revision }));
  }
});

ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "join", role: "desk", callId: "" }));
  await sleep(300);
  ws.send(JSON.stringify({ type: "desk.start", scenarioId: scenario, mode: "mic" }));
  await sleep(800);
  for (const line of lines) {
    while (agentBusy) await sleep(200);
    console.log(`${ts()}   (speaking into the mic: "${line}")`);
    await speak(line);
    await sleep(7000); // let the agent answer
  }
  while (agentBusy) await sleep(200);
  await sleep(2000);
  ws.send(JSON.stringify({ type: "call.end", actionId: `sim-end-${Date.now()}`, revision: 99 }));
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 150_000);
