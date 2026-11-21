import { setTimeout } from "node:timers/promises";
import { critique } from "./critic.ts";
import { judge } from "./record.ts";
import { activate, consolidate, mergeLessons, weightGate, withoutNewWeightLessons, type ActivePlaybook } from "./playbook.ts";
import { learningStore, type LearningStore, type StoredCall } from "./store.ts";
import type { CallRecord, CriticReport, JudgeMetrics, Playbook, PlaybookUpdate } from "./types.ts";

export interface ReviewOutcome {
  metrics: JudgeMetrics;
  critic: CriticReport;
  update: PlaybookUpdate | null; // null when learning is off for this call
  playbook: Playbook;
}

/** The playbook a new call starts with. */
export function playbookForNextCall(store?: LearningStore): ActivePlaybook | Promise<ActivePlaybook> {
  try {
    const current = (store ?? learningStore()).currentPlaybook();
    if (!(current instanceof Promise)) return activate(current);
    // A slow database must not delay the caller indefinitely. Keep a snapshot for the whole call.
    const controller = new AbortController();
    const deadline = setTimeout(5000, undefined, { signal: controller.signal, ref: false }).then(() => {
      throw new Error("Timed out reading the playbook");
    });
    return Promise.race([current.then(activate), deadline]).finally(() => controller.abort());
  } catch (error) {
    return Promise.reject(error);
  }
}

// Playbook updates run one at a time (read, merge, consolidate with a model call, write), so two calls
// ending together can't both claim the same version or overwrite each other.
let lock: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const p = lock.then(job, job);
  lock = p.catch(() => {});
  return p;
};

/**
 * Fold critic reports into the current playbook and save the result as the next version.
 * Same-meaning lessons are consolidated; weight changes must pass the replay gate on every stored
 * labeled call, or they're dropped.
 */
export function applyLessons(reports: { callId: string; critic: CriticReport }[], store: LearningStore = learningStore()) {
  return serial(async () => {
    // Another server may publish while Gemini is consolidating. Merge again against its version.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await store.currentPlaybook();
      const nextVersion = Math.max(await store.latestVersion(), before.version) + 1;
      let { playbook, update } = mergeLessons(before, reports, nextVersion);
      if (update.toVersion === before.version) return { playbook: before, update };
      if (update.added.length) {
        const c = await consolidate(playbook);
        playbook = c.playbook;
        if (c.merged.length) update = { ...update, merged: c.merged };
      }
      const gate = weightGate(before, playbook, await store.calls());
      if (!gate.ok) {
        playbook = withoutNewWeightLessons(playbook, update);
        update = { ...update, rejected: [...update.rejected, ...gate.reasons.map((r) => `weight gate: ${r}`)] };
        playbook.changelog.at(-1)!.note += `; weight change refused by the replay gate`;
      }
      if (await store.savePlaybook(playbook, before.version)) return { playbook, update };
    }
    throw new Error("Playbook changed repeatedly while applying critic lessons");
  });
}

/**
 * After hang-up: judge in code, critique with Gemini, store the call, and (by default) update the playbook.
 * learn=false stores the review but leaves the playbook alone (used by the eval rounds' held-out calls).
 */
export async function reviewAndLearn(record: CallRecord, opts: { learn?: boolean; store?: LearningStore } = {}): Promise<ReviewOutcome> {
  const store = opts.store ?? learningStore();
  const pb = await store.currentPlaybook();
  const metrics = judge(record);
  const critic = await critique(record, metrics, pb);
  const stored: StoredCall = { record, metrics, critic };
  await store.saveCall(stored);
  if (opts.learn === false || !critic.ok) return { metrics, critic, update: null, playbook: pb };
  const { playbook, update } = await applyLessons([{ callId: record.callId, critic }], store);
  return { metrics, critic, update, playbook };
}
