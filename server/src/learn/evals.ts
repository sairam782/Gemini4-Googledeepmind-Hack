import { critique, CRITIC_MODEL } from "./critic.ts";
import { judge } from "./record.ts";
import { activate, consolidate, EMPTY_PLAYBOOK, mergeLessons, weightGate, withoutNewWeightLessons } from "./playbook.ts";
import { PERSONAS, type Persona } from "./personas.ts";
import { simulateCall, SIM_CALLER_MODEL } from "./simulate.ts";
import { learningStore, type LearningStore } from "./store.ts";
import type { CriticReport, JudgeMetrics, Playbook, ScoreBreakdown, SuiteCall, SuiteRun } from "./types.ts";
export type { ScoreBreakdown, SuiteCall, SuiteRun };

/**
 * The eval suite: N calls in a row, each one using the playbook the previous call's review just updated.
 * Every call gets a 0-100 score computed in code, so "better than the last call" is a number, not a vibe.
 */

/** Score changes within this many points count as "the same". */
export const TOLERANCE = 2;

export function scoreCall(m: JudgeMetrics, c: CriticReport, truth: "scam" | "legit"): { total: number; parts: ScoreBreakdown } {
  const verdict = m.verdictCorrect ? 30 : 0;
  // Scams: how long after the money ask the meter reached High (the caller decides when money comes up,
  // so judging the delay keeps the caller's choices out of the agent's score).
  const lag = m.reachedHighAt === null ? null : m.reachedHighAt - (m.firstMoneyAt ?? m.reachedHighAt);
  const detection = truth === "scam"
    ? lag === null ? 0 : lag <= 0 ? 20 : lag === 1 ? 12 : lag === 2 ? 6 : 2
    : m.finalLevel === "High" ? 0 : m.finalLevel === "Medium" ? 12 : 20;
  const checkTiming = truth === "scam"
    ? m.checkBeforeMoney === true || (m.firstMoneyAt === null && m.firstCheckAskedAt !== null) ? 15 : m.firstCheckAskedAt !== null ? 7 : 0
    : m.repeatedCategories.length ? 7 : 15;
  const critic = c.ok ? Math.round(((c.grades.questioning + c.grades.timing - 2) / 8) * 25) : 0;
  const safety = m.leaks.length ? 0 : m.guardBlocks ? 5 : 10;
  const parts = { verdict, detection, checkTiming, critic, safety };
  return { total: verdict + detection + checkTiming + critic + safety, parts };
}

export interface SuiteOptions {
  calls?: number;
  personas?: string[]; // cycled; default: the same persona every call, so each call is comparable
  fresh?: boolean; // start from an empty playbook (default) instead of the shared current one
  promote?: boolean; // at the end, publish the suite's playbook as the shared current one
  log?: (line: string) => void;
  store?: LearningStore;
}

/** Runs the suite, saving progress after every call (so a dashboard can watch it live). */
export async function runSuite(opts: SuiteOptions = {}): Promise<SuiteRun> {
  const store = opts.store ?? learningStore();
  const log = opts.log ?? (() => {});
  const n = Math.max(2, Math.min(10, opts.calls ?? 5));
  const ids = opts.personas?.length ? opts.personas : ["sister-tow"];
  const personas = ids.map((id) => PERSONAS.find((p) => p.id === id)).filter((p): p is Persona => !!p);
  if (!personas.length) throw new Error(`unknown persona: ${ids.join(", ")}. Try: ${PERSONAS.map((p) => p.id).join(", ")}`);
  const fresh = opts.fresh !== false;
  const at = new Date().toISOString();
  const run: SuiteRun = {
    kind: "suite", name: `suite-${at.replace(/[:.]/g, "-")}`, startedAt: at, finishedAt: null, status: "running",
    persona: personas.map((p) => p.id), criticModel: CRITIC_MODEL, callerModel: SIM_CALLER_MODEL,
    startPlaybook: fresh ? "empty" : "current", calls: [], result: null,
  };
  const save = () => store.saveRun(run.name, run);
  await save();

  // The suite keeps its own playbook lineage, so it never disturbs the shared one unless asked to.
  let pb: Playbook = fresh ? structuredClone(EMPTY_PLAYBOOK) : structuredClone(await store.currentPlaybook());
  try {
    for (let i = 0; i < n; i++) {
      const p = personas[i % personas.length];
      const t0 = Date.now();
      const active = pb.lessons.filter((l) => l.status === "active").length;
      log(`call ${i + 1}/${n}: ${p.id} with ${active} active lessons`);
      let sim = await simulateCall(p, { playbook: activate(pb) });
      if (sim.incomplete) {
        log(`  the simulated caller failed (${sim.incomplete.slice(0, 120)}); retrying once`);
        sim = await simulateCall(p, { playbook: activate(pb) });
      }
      if (sim.incomplete) throw new Error(`the simulated caller failed twice: ${sim.incomplete.slice(0, 200)}`);
      const record = sim.call.record();
      const metrics = judge(record);
      const critic = await critique(record, metrics, pb);
      await store.saveCall({ record, metrics, critic });
      const { total, parts } = scoreCall(metrics, critic, p.kind);
      const prev = run.calls.at(-1);
      const delta = prev ? total - prev.score : null;

      // Learn from this call before the next one: merge, consolidate, gate weight changes.
      let added: SuiteCall["lessonsAdded"] = [];
      if (critic.ok) {
        let { playbook, update } = mergeLessons(pb, [{ callId: record.callId, critic }], pb.version + 1);
        // The suite learns fast: a new lesson applies to the very next call (in normal use, minor lessons
        // wait for a second sighting before going active).
        for (const l of playbook.lessons) if (update.added.includes(l.id) && l.status === "candidate") l.status = "active";
        if (update.added.length) playbook = (await consolidate(playbook)).playbook;
        const gate = weightGate(pb, playbook, await store.calls());
        if (!gate.ok) playbook = withoutNewWeightLessons(playbook, update);
        added = playbook.lessons.filter((l) => update.added.includes(l.id) && l.status !== "retired").map(({ id, when, do: d }) => ({ id, when, do: d }));
        pb = playbook;
      }

      run.calls.push({
        n: i + 1, callId: record.callId, persona: p.id, kind: p.kind, playbookLessons: active, score: total, parts, delta,
        // Within ±2 points counts as the same: a live model is never perfectly repeatable.
        trend: delta === null ? "first" : delta > TOLERANCE ? "better" : delta < -TOLERANCE ? "worse" : "same",
        metrics: {
          finalLevel: metrics.finalLevel, locked: metrics.locked, verdictCorrect: metrics.verdictCorrect, reachedHighAt: metrics.reachedHighAt,
          firstMoneyAt: metrics.firstMoneyAt, firstCheckAskedAt: metrics.firstCheckAskedAt, checkBeforeMoney: metrics.checkBeforeMoney,
          agentQuestions: metrics.agentQuestions, callerTurns: metrics.callerTurns,
        },
        grades: critic.grades, ownVerdict: critic.ownVerdict ?? null,
        criticAgreesWithTruth: critic.ownVerdict ? (critic.ownVerdict.call === "unclear" ? null : critic.ownVerdict.call === p.kind) : null,
        summary: critic.summary, caps: critic.caps ?? [], lessonsAdded: added, ms: Date.now() - t0,
      });
      log(`  score ${total}/100${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta})`}: verdict ${parts.verdict}, detection ${parts.detection}, check ${parts.checkTiming}, critic ${parts.critic}, safety ${parts.safety}; ${added.length} lesson(s) learned`);
      await save();
    }
    const scores = run.calls.map((c) => c.score);
    const steps = scores.length - 1;
    const improvedSteps = scores.slice(1).filter((s, i) => s > scores[i] + TOLERANCE).length;
    const monotonic = scores.slice(1).every((s, i) => s >= scores[i] - TOLERANCE);
    run.result = { first: scores[0], last: scores.at(-1)!, best: Math.max(...scores), improvedSteps, steps, monotonic, passed: scores.at(-1)! > scores[0] && monotonic };
    if (opts.promote) {
      const cur = await store.currentPlaybook();
      const next = { ...pb, version: Math.max(await store.latestVersion(), cur.version) + 1, updatedAt: new Date().toISOString() };
      next.changelog = [...next.changelog, { version: next.version, at: next.updatedAt, note: `promoted from ${run.name}` }];
      await store.savePlaybook(next, cur.version);
      log(`promoted the suite's playbook as v${next.version}`);
    }
    run.status = "done";
  } catch (e) {
    run.status = "failed";
    run.error = String((e as Error).message || e).slice(0, 400);
    log(`FAILED: ${run.error}`);
  }
  run.finishedAt = new Date().toISOString();
  await save();
  return run;
}
