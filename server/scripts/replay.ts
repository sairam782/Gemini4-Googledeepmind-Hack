// Headless replay of scripted calls through the full pipeline, ending with the Carbon review and evals.
//   npx tsx --env-file=../.env scripts/replay.ts maya [gapMs]     one call, full event log
//   npx tsx --env-file=../.env scripts/replay.ts all [gapMs]      every scenario in parallel, eval table
import type { CallReview, DeskServerMsg } from "../../shared/brain.ts";
import { LiveCall } from "../src/call.ts";
import { SCENARIOS, type Scenario } from "../src/scenarios.ts";

const id = process.argv[2] ?? "maya";
const gap = Number(process.argv[3] ?? 6000);
const tail = Number(process.env.TAIL_MS ?? 20000);

function logger(t0: number, prefix: string) {
  const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${prefix}`;
  return (m: DeskServerMsg) => {
    switch (m.type) {
      case "turn.final": return console.log(`${ts()} ${m.turn.turnId} ${m.turn.speaker.padEnd(6)} ${m.turn.text}`);
      case "lane.result": return console.log(`${ts()}    [${m.lane} ${m.ms}ms ${m.ok ? "ok" : "FAIL"} @${m.turnId}] ${m.note ?? ""}`);
      case "risk.signal": return console.log(`${ts()}    sign ${m.sign.status.padEnd(11)} ${m.sign.id} (${m.sign.weight > 0 ? "+" : ""}${m.sign.weight}) @${m.sign.evidenceTurnId} via ${m.sign.confirmedBy ?? m.sign.source}`);
      case "risk.level": return console.log(`${ts()}    LEVEL ${m.risk.level} score=${m.risk.score}${m.risk.locked ? " LOCKED" : ""}${m.risk.provisional ? " (provisional)" : ""}`);
      case "notes.update": return console.log(`${ts()}    note ${m.field} = ${m.value} @${m.evidenceTurnId}${m.previous ? ` (was ${m.previous.value})` : ""}`);
      case "decision.open": return console.log(`${ts()}    decision: ${m.text}`);
      case "directions": return console.log(`${ts()}    directions: ${m.directions.map((d) => `${d.suggested ? "*" : ""}[${d.source}] ${d.label}: "${d.say}"`).join(" | ") || "(cleared)"}`);
      case "directions.withdrawn": return console.log(`${ts()}    withdrawn: ${m.label} (${m.reason} @${m.evidenceTurnId})`);
      case "error": return console.log(`${ts()}    ERROR ${m.message}`);
    }
  };
}

async function run(sc: Scenario, verbose: boolean): Promise<CallReview> {
  const call = new LiveCall(`${sc.id}-replay`, { from: sc.from, inContacts: sc.inContacts }, sc.expected);
  if (verbose) call.subscribe(logger(Date.now(), ""));
  const review = new Promise<CallReview>((resolve) => call.subscribe((m) => m.type === "call.review" && resolve(m.review), false));
  call.brain.addTurn("alex", "Hello?");
  for (const line of sc.script) {
    call.caller(line);
    await new Promise((r) => setTimeout(r, gap));
  }
  await new Promise((r) => setTimeout(r, tail)); // let the slower lanes finish
  call.end("script finished");
  return review;
}

function printReview(sc: Scenario, r: CallReview) {
  console.log(`\n=== ${sc.title} (${sc.kind}) → ${r.finalLevel}${r.locked ? " LOCKED" : ""}, verdict ${r.verdict}`);
  console.log(`  ${r.summary}`);
  r.followUps.forEach((f) => console.log(`  follow-up: ${f.action} (${f.why})`));
  r.evals.forEach((e) => console.log(`  ${e.pass ? "PASS" : "FAIL"} ${e.name}: ${e.detail}`));
  console.log(`  latency: ${Object.entries(r.latency).map(([l, v]) => `${l} ${v!.medianMs}ms×${v!.runs}${v!.failures ? ` (${v!.failures} failed)` : ""}`).join(", ")}`);
}

if (id === "all") {
  const results = await Promise.all(SCENARIOS.map(async (sc) => [sc, await run(sc, false)] as const));
  results.forEach(([sc, r]) => printReview(sc, r));
  const evals = results.flatMap(([, r]) => r.evals);
  console.log(`\nTOTAL ${evals.filter((e) => e.pass).length}/${evals.length} evals pass across ${results.length} calls`);
} else {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`unknown scenario ${id}; try all, ${SCENARIOS.map((s) => s.id).join(", ")}`);
  printReview(sc, await run(sc, true));
}
process.exit(0);
