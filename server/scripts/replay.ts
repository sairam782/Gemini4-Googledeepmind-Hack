// Headless replay of a scripted call through the brain. Usage:
//   npx tsx --env-file=../.env scripts/replay.ts maya [gapMs]
import type { DeskServerMsg } from "../../shared/brain.ts";
import { CallBrain } from "../src/brain/orchestrator.ts";
import { SCENARIOS } from "../src/scenarios.ts";

const id = process.argv[2] ?? "maya";
const gap = Number(process.argv[3] ?? 4000);
const sc = SCENARIOS.find((s) => s.id === id);
if (!sc) throw new Error(`unknown scenario ${id}; try ${SCENARIOS.map((s) => s.id).join(", ")}`);

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const log = (m: DeskServerMsg) => {
  switch (m.type) {
    case "turn.final": return console.log(`${ts()} ${m.turn.turnId} ${m.turn.speaker.padEnd(6)} ${m.turn.text}`);
    case "lane.result": return console.log(`${ts()}    [${m.lane} ${m.ms}ms ${m.ok ? "ok" : "FAIL"} @${m.turnId}] ${m.note ?? ""}`);
    case "risk.signal": return console.log(`${ts()}    sign ${m.sign.status.padEnd(11)} ${m.sign.id} (${m.sign.weight > 0 ? "+" : ""}${m.sign.weight}) @${m.sign.evidenceTurnId} via ${m.sign.confirmedBy ?? m.sign.source}`);
    case "risk.level": return console.log(`${ts()}    LEVEL ${m.risk.level} score=${m.risk.score}${m.risk.locked ? " LOCKED" : ""}${m.risk.provisional ? " (provisional)" : ""}`);
    case "notes.update": return console.log(`${ts()}    note ${m.field} = ${m.value} @${m.evidenceTurnId}${m.previous ? ` (was ${m.previous.value})` : ""}`);
    case "decision.open": return console.log(`${ts()}    decision: ${m.text}`);
    case "directions": return console.log(`${ts()}    directions: ${m.directions.map((d) => `${d.suggested ? "*" : ""}[${d.source}] ${d.label}: "${d.say}"`).join(" | ") || "(cleared)"}`);
    case "directions.withdrawn": return console.log(`${ts()}    withdrawn: ${m.label} (${m.reason} @${m.evidenceTurnId})`);
  }
};

const brain = new CallBrain({ from: sc.from, inContacts: sc.inContacts }, log, () => 1);
brain.addTurn("alex", "Hello?");
for (const line of sc.script) {
  brain.addTurn("caller", line);
  await new Promise((r) => setTimeout(r, gap));
}
await new Promise((r) => setTimeout(r, Number(process.env.TAIL_MS ?? 45000))); // let Neon finish
brain.ended = true;
console.log(`expected: ${sc.expected.level} — ${sc.expected.verdict}`);
process.exit(0);
