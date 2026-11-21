import { critique } from "./critic.ts";
import { judge } from "./record.ts";
import { activate, consolidate, mergeLessons, weightGate, withoutNewWeightLessons, type ActivePlaybook } from "./playbook.ts";
import { learningStore, type LearningStore, type FileStore, type StoredCall } from "./store.ts";
import type { CallRecord, CriticReport, JudgeMetrics, Playbook, PlaybookUpdate } from "./types.ts";

export interface ReviewOutcome {
  metrics: JudgeMetrics;
  critic: CriticReport;
  update: PlaybookUpdate | null; // null when learning is off for this call
  playbook: Playbook;
}

/** The playbook a new call starts with. */
export function playbookForNextCall(store: LearningStore = learningStore()): ActivePlaybook {
  return activate(store.currentPlaybook());
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
export function applyLessons(reports: { callId: string; critic: CriticReport }[], store: FileStore = learningStore()) {
  return serial(async () => {
    const before = store.currentPlaybook();
    const nextVersion = Math.max(store.latestVersion(), before.version) + 1;
    let { playbook, update } = mergeLessons(before, reports, nextVersion);
    if (update.toVersion === before.version) return { playbook: before, update };
    if (update.added.length) {
      const c = await consolidate(playbook);
      playbook = c.playbook;
      if (c.merged.length) update = { ...update, merged: c.merged };
    }
    const gate = weightGate(before, playbook, store.calls());
    if (!gate.ok) {
      playbook = withoutNewWeightLessons(playbook, update);
      update = { ...update, rejected: [...update.rejected, ...gate.reasons.map((r) => `weight gate: ${r}`)] };
      playbook.changelog.at(-1)!.note += `; weight change refused by the replay gate`;
    }
    store.savePlaybook(playbook);
    return { playbook, update };
  });
}

/**
 * After hang-up: judge in code, critique with Gemini, store the call, and (by default) update the playbook.
 * learn=false stores the review but leaves the playbook alone (used by the eval rounds' held-out calls).
 */
export async function reviewAndLearn(record: CallRecord, opts: { learn?: boolean; store?: FileStore } = {}): Promise<ReviewOutcome> {
  const store = opts.store ?? learningStore();
  const pb = store.currentPlaybook();
  const metrics = judge(record);
  const critic = await critique(record, metrics, pb);
  const stored: StoredCall = { record, metrics, critic };
  store.saveCall(stored);
  if (opts.learn === false || !critic.ok) return { metrics, critic, update: null, playbook: pb };
  const { playbook, update } = await applyLessons([{ callId: record.callId, critic }], store);
  return { metrics, critic, update, playbook };
}
