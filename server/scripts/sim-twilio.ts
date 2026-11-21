// Pretends to be Twilio: streams a scenario as real phone audio (8 kHz µ-law) into ws://localhost:8787/twilio,
// and pretends to be Alex's app on /ws (role "app"): takes over, picks a direction, takes back mid-sentence.
// Needs the server running (npm run dev).
//   npx tsx --env-file=../.env scripts/sim-twilio.ts [scenario]
import WebSocket from "ws";
import type { DeskServerMsg, Direction } from "../../shared/brain.ts";
import { SCENARIOS } from "../src/scenarios.ts";
import { renderSpeech } from "../src/tts.ts";
import { encodeMulaw, parseWav, resample } from "../src/audio.ts";

const sc = SCENARIOS.find((s) => s.id === (process.argv[2] ?? "maya"))!;
const base = `ws://localhost:${process.env.API_PORT || 8787}`;
const callSid = `CAsim${Date.now()}`;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`, ...a);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (ws: WebSocket) => new Promise((r) => ws.once("open", r));

// Pre-render the caller's lines as 8 kHz µ-law, like a real phone line.
const clips = await Promise.all(
  sc.script.map(async (line) => {
    const { samples, rate } = parseWav(await renderSpeech(line, "Puck"));
    return encodeMulaw(resample(samples, rate, 8000));
  }),
);
log(`rendered ${clips.length} caller lines`);

// ---- "Twilio"
const tw = new WebSocket(`${base}/twilio`);
await open(tw);
const stats = { agentFrames: 0, marks: 0, clears: 0 };
tw.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.event === "media") stats.agentFrames++;
  if (m.event === "clear") {
    stats.clears++;
    log("twilio ← clear (agent audio stopped)");
  }
  if (m.event === "mark") {
    stats.marks++;
    const playMs = stats.agentFrames * 20;
    log(`twilio ← agent audio ${stats.agentFrames} frames (${(playMs / 1000).toFixed(1)} s), mark ${m.mark.name}`);
    stats.agentFrames = 0;
    setTimeout(() => tw.readyState === tw.OPEN && tw.send(JSON.stringify({ event: "mark", streamSid: "MZsim", mark: m.mark })), Math.min(playMs, 3000));
  }
});
tw.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
tw.send(JSON.stringify({
  event: "start",
  start: { streamSid: "MZsim", callSid, tracks: ["inbound"], customParameters: { from: sc.from, inContacts: String(sc.inContacts) } },
}));
await wait(300);

// ---- "Alex's app"
const app = new WebSocket(`${base}/ws`);
await open(app);
let revision = 0;
let dirs: Direction[] = [];
let interims = 0;
let review: Extract<DeskServerMsg, { type: "call.review" }>["review"] | null = null;
app.on("message", (raw) => {
  const m = JSON.parse(String(raw)) as DeskServerMsg;
  if (m.type === "state") revision = m.revision;
  if (m.type === "caption.interim") interims++;
  if (m.type === "turn.final") log(`${m.turn.turnId} ${m.turn.speaker}: ${m.turn.text}`);
  if (m.type === "directions") dirs = m.directions;
  if (m.type === "risk.level") log(`   risk ${m.risk.level} ${m.risk.score}${m.risk.locked ? " LOCKED" : ""}`);
  if (m.type === "action.rejected") log(`   tap rejected: ${m.reason}`);
  if (m.type === "agent.cut") log(`   agent cut at ${m.turnId}`);
  if (m.type === "error") log(`   error: ${m.message}`);
  if (m.type === "lane.result" && /held|strategy:/.test(m.note ?? "")) log(`   [${m.lane} @${m.turnId}] ${m.note}`);
  if (m.type === "directions" && m.directions.length) log(`   board: ${m.directions.map((d) => `${d.suggested ? "*" : ""}[${d.source}] ${d.label}`).join(" | ")}`);
  if (m.type === "call.review") review = m.review;
});
app.send(JSON.stringify({ type: "join", role: "app", callId: callSid }));
const tap = (m: Record<string, unknown>) => app.send(JSON.stringify({ ...m, actionId: crypto.randomUUID(), revision }));

async function stream(ulaw: Buffer) {
  const silence = Buffer.alloc(8000 * 1.2, 0xff);
  const all = Buffer.concat([ulaw, silence]);
  for (let i = 0; i < all.length; i += 800) {
    // 100 ms per message batch of five 20 ms frames, in real time
    for (let f = i; f < Math.min(i + 800, all.length); f += 160) {
      tw.send(JSON.stringify({ event: "media", streamSid: "MZsim", media: { track: "inbound", payload: all.subarray(f, f + 160).toString("base64") } }));
    }
    await wait(100);
  }
}

for (let i = 0; i < clips.length; i++) {
  await stream(clips[i]);
  await wait(2500);
  if (i === 1) {
    log("app → Agent take over");
    tap({ type: "control.delegate" });
    await wait(9000); // intro plays
  }
  if (i === 2 && dirs.length) {
    const d = dirs.find((x) => x.suggested) ?? dirs[0];
    log(`app → pick "${d.label}" [${d.source}]`);
    tap({ type: "direction.pick", directionId: d.id });
    await wait(600);
    log("app → Take back (mid-sentence)");
    tap({ type: "control.takeback", localSilenceMs: 0 });
    await wait(1000);
  }
}
await wait(8000);
tw.send(JSON.stringify({ event: "stop", streamSid: "MZsim" }));
log("twilio → stop (hang-up)");
for (let i = 0; i < 90 && !review; i++) await wait(1000);
const r = review as typeof review;
log(`interim caption updates: ${interims}; agent clips: ${stats.marks}; clears: ${stats.clears}`);
if (r) {
  console.log(`\nREVIEW ${r.finalLevel}${r.locked ? " LOCKED" : ""} verdict=${r.verdict}\n  ${r.summary}`);
  r.followUps.forEach((f) => console.log(`  follow-up: ${f.action}`));
  r.evals.forEach((e) => console.log(`  ${e.pass ? "PASS" : "FAIL"} ${e.name}: ${e.detail}`));
} else console.log("no review received");
process.exit(0);
