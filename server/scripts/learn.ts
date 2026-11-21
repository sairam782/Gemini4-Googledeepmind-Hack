// Learning rounds: does the agent get better call after call?
//
//   npx tsx --env-file=../.env scripts/learn.ts                 3 rounds from the current playbook
//   npx tsx --env-file=../.env scripts/learn.ts --rounds 5 --fresh    start from an empty playbook (v0)
//   npx tsx --env-file=../.env scripts/learn.ts --show          print the current playbook and exit
//   npx tsx --env-file=../.env scripts/learn.ts --rollback 2    make playbook v2 current again
//
// Each round:
//   1. TRAIN   simulated calls (personas.ts, set "train") with the current playbook
//   2. CRITIC  Gemini 4 Neon reviews each call and proposes lessons
//   3. MERGE   lessons fold into a candidate playbook (weight changes must pass the replay gate)
//   4. HOLDOUT calls the critic never learns from, run with the candidate playbook, scored in code
//   5. KEEP or ROLL BACK: the candidate stays only if held-out results didn't get worse
// Round 0 is the baseline: held-out calls with the starting playbook.
import { PERSONAS, type Persona } from "../src/learn/personas.ts";
import { simulateCall } from "../src/learn/simulate.ts";
import { activate, type ActivePlaybook } from "../src/learn/playbook.ts";
import { applyLessons, reviewAndLearn, type ReviewOutcome } from "../src/learn/pipeline.ts";
import { learningStore } from "../src/learn/store.ts";
import { CRITIC_MODEL } from "../src/learn/critic.ts";
import { SIM_CALLER_MODEL } from "../src/learn/simulate.ts";
import type { CriticReport, JudgeMetrics } from "../src/learn/types.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROUNDS = Number(opt("rounds", "3"));
const CONCURRENCY = Number(opt("concurrency", "3"));
const MAX_TURNS = Number(opt("max-turns", "7"));
const VERBOSE = flag("verbose");
const store = learningStore();

// ---------------------------------------------------------------- one-off commands

if (flag("show")) {
  const pb = await store.currentPlaybook();
  console.log(`playbook v${pb.version} (${pb.updatedAt})`);
  for (const l of pb.lessons) console.log(`  ${l.id} [${l.status}] seen ${l.seen} sev ${l.severity}: when ${l.when}: ${l.do}  ${JSON.stringify(l.action)}`);
  pb.changelog.forEach((c) => console.log(`  v${c.version} ${c.at.slice(0, 19)} ${c.note}`));
  process.exit(0);
}
if (args.includes("--rollback")) {
  const v = Number(opt("rollback", "-1"));
  await store.setCurrent(v);
  console.log(`current playbook is now v${v}`);
  process.exit(0);
}
if (flag("fresh")) await store.setCurrent(0);

// ---------------------------------------------------------------- helpers

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

interface CallResult { persona: Persona; metrics: JudgeMetrics; critic: CriticReport; failed?: boolean }

async function runCall(p: Persona, pb: ActivePlaybook, round: number): Promise<CallResult> {
  const t0 = Date.now();
  const { call, incomplete } = await simulateCall(p, { playbook: pb, maxCallerTurns: MAX_TURNS, log: VERBOSE ? (l) => console.log(`  [${p.id}] ${l}`) : undefined });
  const record = call.record();
  if (incomplete) {
    console.log(`  r${round} ${p.set.padEnd(7)} ${p.id.padEnd(18)} INCOMPLETE (not scored, not learned from): ${incomplete.slice(0, 200)}`);
    const { judge } = await import("../src/learn/record.ts");
    return { persona: p, metrics: judge(record), critic: { callId: record.callId, model: CRITIC_MODEL, ms: 0, ok: false, grades: { classification: 0, questioning: 0, timing: 0, safety: 0 }, summary: "", findings: [], proposed: [], rejected: [] }, failed: true };
  }
  // Every call is critiqued and stored; only the merge step below changes the playbook.
  const out: ReviewOutcome = await reviewAndLearn(record, { learn: false });
  const m = out.metrics;
  console.log(
    `  r${round} ${p.set.padEnd(7)} ${p.id.padEnd(18)} ${p.kind.padEnd(5)} → ${m.finalLevel.padEnd(6)}${m.verdictCorrect ? "✓" : "✗"}` +
      ` high@${m.reachedHighAt ?? "-"} check@${m.firstCheckAskedAt ?? "-"} money@${m.firstMoneyAt ?? "-"}` +
      ` grades c${out.critic.grades.classification} q${out.critic.grades.questioning} t${out.critic.grades.timing} s${out.critic.grades.safety}` +
      ` lessons ${out.critic.proposed.length}${out.critic.ok ? "" : " (critic failed)"} · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  return { persona: p, metrics: m, critic: out.critic };
}

interface Summary {
  calls: number;
  scamsCaught: string; // "2/2"
  falseAlarms: number;
  leaks: number;
  avgHighAtScam: number | null;
  checkBeforeMoney: string;
  avgCheckAt: number | null;
  avgQuestioning: number;
  avgTiming: number;
  avgClassification: number;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
function summarize(all: CallResult[]): Summary {
  const rs = all.filter((r) => !r.failed); // a call that never happened says nothing about the playbook
  const scams = rs.filter((r) => r.persona.kind === "scam");
  const ok = rs.filter((r) => r.critic.ok);
  const cbm = scams.filter((r) => r.metrics.checkBeforeMoney !== null);
  return {
    calls: rs.length,
    scamsCaught: `${scams.filter((r) => r.metrics.verdictCorrect).length}/${scams.length}`,
    falseAlarms: rs.filter((r) => r.metrics.falseAlarm).length,
    leaks: rs.reduce((a, r) => a + r.metrics.leaks.length, 0),
    avgHighAtScam: avg(scams.map((r) => r.metrics.reachedHighAt).filter((x): x is number => x !== null)),
    checkBeforeMoney: `${cbm.filter((r) => r.metrics.checkBeforeMoney).length}/${cbm.length}`,
    avgCheckAt: avg(rs.map((r) => r.metrics.firstCheckAskedAt).filter((x): x is number => x !== null)),
    avgQuestioning: avg(ok.map((r) => r.critic.grades.questioning)) ?? 0,
    avgTiming: avg(ok.map((r) => r.critic.grades.timing)) ?? 0,
    avgClassification: avg(ok.map((r) => r.critic.grades.classification)) ?? 0,
  };
}

const caught = (s: Summary) => Number(s.scamsCaught.split("/")[0]);
const scamTotal = (s: Summary) => Number(s.scamsCaught.split("/")[1]);
/** The candidate stays only if held-out calls didn't get worse on what matters most. */
function worse(now: Summary, before: Summary): string | null {
  if (now.leaks > 0) return `agent leaked analysis or a code (${now.leaks})`;
  if (now.falseAlarms > before.falseAlarms) return `false alarms ${before.falseAlarms} → ${now.falseAlarms}`;
  // Compare rates, not counts: an incomplete call drops out of one side.
  if (scamTotal(now) && scamTotal(before) && caught(now) / scamTotal(now) < caught(before) / scamTotal(before)) return `scams caught ${before.scamsCaught} → ${now.scamsCaught}`;
  if (now.avgQuestioning + now.avgTiming < before.avgQuestioning + before.avgTiming - 0.75) return `questioning+timing grades dropped (${before.avgQuestioning}+${before.avgTiming} → ${now.avgQuestioning}+${now.avgTiming})`;
  return null;
}

// ---------------------------------------------------------------- rounds

const train = PERSONAS.filter((p) => p.set === "train");
const holdout = PERSONAS.filter((p) => p.set === "holdout");
const start = await store.currentPlaybook();
console.log(`Learning rounds: ${ROUNDS} · critic ${CRITIC_MODEL} · caller ${SIM_CALLER_MODEL} · ${train.length} train + ${holdout.length} held-out personas · starting at playbook v${start.version}\n`);

const table: { round: number; playbook: number; kept: boolean; note: string; holdout: Summary; train?: Summary }[] = [];

console.log("Round 0 (baseline): held-out calls");
const base0 = await pool(holdout, CONCURRENCY, (p) => runCall(p, activate(start), 0));
if (base0.every((r) => r.failed)) {
  console.error("\nEvery simulated call failed: the models aren't reachable. Check GEMINI_API_KEY in .env and your network.");
  process.exit(1);
}
let baseline = summarize(base0);
table.push({ round: 0, playbook: start.version, kept: true, note: "baseline", holdout: baseline });

for (let round = 1; round <= ROUNDS; round++) {
  const pb = await store.currentPlaybook();
  console.log(`\nRound ${round}: train with playbook v${pb.version}`);
  const trainRes = await pool(train, CONCURRENCY, (p) => runCall(p, activate(pb), round));

  const { playbook: cand, update } = await applyLessons(trainRes.filter((r) => r.critic.ok).map((r) => ({ callId: r.critic.callId, critic: r.critic })));
  console.log(`  playbook v${pb.version} → v${cand.version}: added ${update.added.join(", ") || "-"}; reinforced ${[...new Set(update.reinforced)].join(", ") || "-"}; promoted ${update.promoted.join(", ") || "-"}${update.merged?.length ? `; merged ${update.merged.join(", ")}` : ""}${update.rejected.length ? `; rejected: ${update.rejected.join(" | ")}` : ""}`);
  if (cand.version === pb.version) {
    table.push({ round, playbook: pb.version, kept: true, note: "no new lessons", holdout: baseline, train: summarize(trainRes) });
    console.log("  no change to the playbook; skipping the held-out run");
    continue;
  }

  console.log(`Round ${round}: held-out calls with candidate v${cand.version}`);
  const hold = summarize(await pool(holdout, CONCURRENCY, (p) => runCall(p, activate(cand), round)));
  const why = worse(hold, baseline);
  if (why) {
    if (!(await store.setCurrent(pb.version, cand.version))) {
      throw new Error(`Cannot roll back v${cand.version}: a newer playbook was already made current`);
    }
    console.log(`  ROLLED BACK to v${pb.version}: ${why}`);
  } else {
    baseline = hold;
    console.log(`  kept v${cand.version}`);
  }
  table.push({ round, playbook: cand.version, kept: !why, note: why ?? `${update.added.length} added, ${update.promoted.length} promoted`, holdout: hold, train: summarize(trainRes) });
}

// ---------------------------------------------------------------- report

console.log("\nHeld-out results per round (calls the critic never learned from)");
console.log("round  playbook  kept  scams  false-alarms  high@(scams)  check-before-money  check@  questioning  timing  classification  note");
for (const r of table) {
  const h = r.holdout;
  console.log(
    `${String(r.round).padEnd(7)}v${String(r.playbook).padEnd(9)}${(r.kept ? "yes" : "no").padEnd(6)}${h.scamsCaught.padEnd(7)}${String(h.falseAlarms).padEnd(14)}${String(h.avgHighAtScam ?? "-").padEnd(14)}${h.checkBeforeMoney.padEnd(20)}${String(h.avgCheckAt ?? "-").padEnd(8)}${String(h.avgQuestioning).padEnd(13)}${String(h.avgTiming).padEnd(8)}${String(h.avgClassification).padEnd(16)}${r.note}`,
  );
}
const final = await store.currentPlaybook();
console.log(`\nCurrent playbook: v${final.version}, ${final.lessons.filter((l) => l.status === "active").length} active lessons`);
for (const l of final.lessons.filter((x) => x.status === "active")) console.log(`  ${l.id} (seen ${l.seen}): when ${l.when}: ${l.do}`);
const name = `learn-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await store.saveRun(name, { at: new Date().toISOString(), critic: CRITIC_MODEL, caller: SIM_CALLER_MODEL, rounds: table, playbook: final.version });
console.log(`\nSaved eval results as ${name}`);
process.exit(0);
