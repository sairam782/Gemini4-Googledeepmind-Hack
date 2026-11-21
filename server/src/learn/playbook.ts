import type { DirectionCategory } from "../../../shared/brain.ts";
import { SIGNS, SIGN_IDS, canonicalSignId, levelFor } from "../brain/catalog.ts";
import { generateJson, thinkingFor } from "../brain/llm.ts";
import type { CriticReport, Lesson, LessonAction, Playbook, PlaybookUpdate } from "./types.ts";
import type { StoredCall } from "./store.ts";

export const CATEGORIES: DirectionCategory[] = ["verify_identity", "offer_callback", "probe_details", "slow_down", "decline", "take_message"];
export const MAX_ACTIVE = 10;
export const EMPTY_PLAYBOOK: Playbook = {
  version: 0,
  updatedAt: new Date(0).toISOString(),
  lessons: [],
  changelog: [{ version: 0, at: new Date(0).toISOString(), note: "empty playbook" }],
};
const MAX_WEIGHT_SHIFT = 2;

/**
 * Words a lesson may never contain. Lessons tune detection and questions; they can't make the agent
 * pay, approve, share codes, hide that it's an AI, speak as Alex or end the call.
 */
const UNSAFE =
  /\b(send|pay|transfer|wire|venmo|zelle)\b[^.]{0,30}\b(money|\$|it|them|funds)\b|\b(share|read (out|back)|give)\b[^.]{0,15}\bcode\b|\bapprove|\bagree to\b|\b(don'?t|never|stop|skip|avoid)\b[^.]{0,25}\b(say|mention|disclose|tell|admit)\b[^.]{0,30}\b(ai|assistant|automated)\b|\bpretend\b|\bas alex\b|\bhang up\b|\bend the call\b|\bignore\b[^.]{0,20}\b(guard|rule|safety)\b/i;

// ---------------------------------------------------------------- validation

export function validateLesson(raw: unknown): { lesson?: CriticReport["proposed"][number]; reason?: string } {
  const x = raw as Partial<Omit<CriticReport["proposed"][number], "action">> & { action?: unknown };
  const when = typeof x?.when === "string" ? x.when.trim() : "";
  const todo = typeof x?.do === "string" ? x.do.trim() : "";
  if (when.length < 8 || todo.length < 8) return { reason: "missing when/do" };
  if (when.length > 220 || todo.length > 220) return { reason: "too long" };
  if (UNSAFE.test(`${when} ${todo}`)) return { reason: `unsafe: "${todo.slice(0, 60)}"` };
  const sev = [1, 2, 3].includes(Number(x.severity)) ? (Number(x.severity) as 1 | 2 | 3) : 1;
  const evidence = Array.isArray(x.evidence) ? x.evidence : [];
  const a = (x.action ?? {}) as { type?: string; category?: string; whenSigns?: unknown; notInContactsOnly?: unknown; sign?: string; delta?: number };
  let action: LessonAction;
  switch (a.type) {
    case "prefer_direction": {
      const whenSigns = (Array.isArray(a.whenSigns) ? (a.whenSigns as unknown[]) : []).filter((s): s is string => SIGN_IDS.includes(s as string));
      if (!CATEGORIES.includes(a.category as DirectionCategory)) return { reason: `bad category ${String(a.category)}` };
      if (!whenSigns.length || whenSigns.length > 3) return { reason: "prefer_direction needs 1-3 known signs" };
      if (whenSigns.some((s) => SIGNS[s].weight < 0)) return { reason: "prefer_direction can't trigger on a reassuring sign" };
      action = { type: "prefer_direction", category: a.category as DirectionCategory, whenSigns: [...new Set(whenSigns)].sort(), ...(a.notInContactsOnly ? { notInContactsOnly: true } : {}) };
      break;
    }
    case "adjust_weight": {
      if (!SIGN_IDS.includes(a.sign as string)) return { reason: `unknown sign ${String(a.sign)}` };
      if (a.delta !== 1 && a.delta !== -1) return { reason: "delta must be +1 or -1" };
      action = { type: "adjust_weight", sign: a.sign as string, delta: a.delta };
      break;
    }
    case "planner_hint":
    case "detection_hint":
      action = { type: a.type };
      break;
    default:
      return { reason: `unknown action ${String(a.type)}` };
  }
  return { lesson: { when, do: todo, action, severity: sev, evidence } };
}

// ---------------------------------------------------------------- what the next call reads

export interface ActivePlaybook {
  version: number;
  /** Per-sign weight shift from active adjust_weight lessons (clamped, never flips a sign). */
  weightDelta: Record<string, number>;
  prefer: { id: string; category: DirectionCategory; whenSigns: string[]; notInContactsOnly?: boolean }[];
  plannerText: string; // "" when there are no lessons
  detectionText: string;
}

export function weightDeltas(lessons: Lesson[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const lesson of lessons) {
    if (lesson.status !== "active" || lesson.action.type !== "adjust_weight") continue;
    const sign = canonicalSignId(lesson.action.sign);
    if (SIGNS[sign]) d[sign] = (d[sign] ?? 0) + lesson.action.delta;
  }
  for (const [sign, v] of Object.entries(d)) {
    const base = SIGNS[sign].weight;
    let shift = Math.max(-MAX_WEIGHT_SHIFT, Math.min(MAX_WEIGHT_SHIFT, v));
    // A warning sign stays at least +1, a reassuring sign at most -1.
    if (base > 0) shift = Math.max(shift, 1 - base);
    else shift = Math.min(shift, -1 - base);
    d[sign] = shift;
  }
  return d;
}

export function activate(pb: Playbook): ActivePlaybook {
  const active = pb.lessons.filter((l) => l.status === "active");
  const line = (l: Lesson) => `- (${l.id}) When ${l.when.replace(/\.$/, "")}: ${l.do}`;
  return {
    version: pb.version,
    weightDelta: weightDeltas(active),
    prefer: active.flatMap((l) => (l.action.type === "prefer_direction" ? [{ id: l.id, ...l.action }] : [])).map(({ type: _t, ...rule }) => ({ ...rule, whenSigns: rule.whenSigns.map(canonicalSignId) })),
    plannerText: active.filter((l) => l.action.type === "prefer_direction" || l.action.type === "planner_hint").map(line).join("\n"),
    detectionText: active.filter((l) => l.action.type === "detection_hint" || l.action.type === "adjust_weight").map(line).join("\n"),
  };
}

// ---------------------------------------------------------------- merge

// Words every lesson shares; they say nothing about whether two lessons mean the same thing.
const STOP = new Set("the and for with that this when then than they them their caller callers call calls assistant alex any are was were has have had not but before after into from about what which who its it's".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
/** Jaccard overlap of the meaningful words. */
function similar(a: string, b: string) {
  const A = words(a), B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

function sameLesson(a: Pick<Lesson, "action" | "when" | "do">, b: Pick<Lesson, "action" | "when" | "do">) {
  if (a.action.type !== b.action.type) return false;
  if (a.action.type === "prefer_direction" && b.action.type === "prefer_direction")
    return a.action.category === b.action.category && a.action.whenSigns.join() === b.action.whenSigns.join();
  if (a.action.type === "adjust_weight" && b.action.type === "adjust_weight") return a.action.sign === b.action.sign && a.action.delta === b.action.delta;
  return similar(`${a.when} ${a.do}`, `${b.when} ${b.do}`) >= 0.5;
}

const score = (l: Lesson) => l.seen * l.severity;

/**
 * Fold one or more critic reports into the playbook. Returns the next version (or the same
 * playbook if nothing changed). New lessons with severity ≥ 2 go active at once; minor ones wait as
 * candidates until a second call proposes them. At most MAX_ACTIVE stay active.
 */
export function mergeLessons(pb: Playbook, reports: { callId: string; critic: CriticReport }[], nextVersion: number): { playbook: Playbook; update: PlaybookUpdate } {
  const next: Playbook = structuredClone(pb);
  next.version = nextVersion;
  const update: PlaybookUpdate = { fromVersion: pb.version, toVersion: nextVersion, added: [], reinforced: [], promoted: [], rejected: [] };
  let seq = next.lessons.reduce((m, l) => Math.max(m, Number(l.id.slice(2)) || 0), 0);

  for (const { callId, critic } of reports) {
    for (const p of critic.proposed) {
      const live = next.lessons.filter((l) => l.status !== "retired");
      const dup = live.find((l) => sameLesson(l, p));
      if (dup) {
        dup.seen++;
        dup.severity = Math.max(dup.severity, p.severity) as 1 | 2 | 3;
        dup.evidence.push({ callId, turns: p.evidence.flatMap((e) => e.turns).slice(0, 6) });
        dup.evidence = dup.evidence.slice(-8);
        dup.updatedInVersion = nextVersion;
        update.reinforced.push(dup.id);
        if (dup.status === "candidate" && dup.seen >= 2) {
          dup.status = "active";
          update.promoted.push(dup.id);
        }
        continue;
      }
      if (p.action.type === "adjust_weight") {
        const a = p.action;
        const clash = live.find((l) => l.action.type === "adjust_weight" && l.action.sign === a.sign && l.action.delta !== a.delta);
        if (clash) {
          update.rejected.push(`${a.sign} ${a.delta > 0 ? "+" : ""}${a.delta}: conflicts with ${clash.id}`);
          continue;
        }
      }
      const id = `L-${String(++seq).padStart(3, "0")}`;
      next.lessons.push({
        ...p,
        evidence: [{ callId, turns: p.evidence.flatMap((e) => e.turns).slice(0, 6) }],
        id,
        status: p.severity >= 2 ? "active" : "candidate",
        seen: 1,
        addedInVersion: nextVersion,
        updatedInVersion: nextVersion,
      });
      update.added.push(id);
    }
  }

  // Keep the strongest MAX_ACTIVE active; older, weaker ones retire.
  const active = next.lessons.filter((l) => l.status === "active").sort((a, b) => score(b) - score(a) || b.updatedInVersion - a.updatedInVersion);
  for (const l of active.slice(MAX_ACTIVE)) l.status = "retired";

  const changed = update.added.length + update.reinforced.length + update.promoted.length > 0;
  if (!changed) return { playbook: pb, update: { ...update, toVersion: pb.version } };
  next.updatedAt = new Date().toISOString();
  next.changelog.push({
    version: nextVersion,
    at: next.updatedAt,
    note: [update.added.length && `added ${update.added.join(", ")}`, update.reinforced.length && `reinforced ${[...new Set(update.reinforced)].join(", ")}`, update.promoted.length && `promoted ${update.promoted.join(", ")}`].filter(Boolean).join("; "),
  });
  return { playbook: next, update };
}

// ---------------------------------------------------------------- weight gate (code, no model)

/** Caller line (1-based) where a stored call would first reach High with these weight shifts. */
export function highAtWith(c: StoredCall, delta: Record<string, number>): number | null {
  const callerTurns = c.record.turns.filter((t) => t.speaker === "caller").map((t) => t.turnId);
  const kept = c.record.signs.filter((s) => s.status !== "removed");
  for (let i = 0; i < callerTurns.length; i++) {
    const upTo = new Set(callerTurns.slice(0, i + 1));
    const score = kept.filter((s) => upTo.has(s.evidenceTurnId)).reduce((total, sign) => {
      const id = canonicalSignId(sign.id);
      return total + (SIGNS[id]?.weight ?? sign.weight) + (delta[id] ?? 0);
    }, 0);
    if (levelFor(score) === "High") return i + 1;
  }
  return null;
}

/**
 * Replays every labeled stored call with the old and new weights. A weight change is refused if it
 * makes a legitimate call reach High, or makes any scam reach High later than before.
 */
export function weightGate(before: Playbook, after: Playbook, history: StoredCall[]): { ok: boolean; reasons: string[] } {
  const d0 = weightDeltas(before.lessons), d1 = weightDeltas(after.lessons);
  if (JSON.stringify(d0) === JSON.stringify(d1)) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  for (const c of history) {
    if (c.record.label === "unknown") continue;
    const h0 = highAtWith(c, d0), h1 = highAtWith(c, d1);
    if (c.record.label === "legit" && h1 !== null && h0 === null) reasons.push(`${c.record.callId}: legitimate call would reach High at line ${h1}`);
    if (c.record.label === "scam" && h0 !== null && (h1 === null || h1 > h0)) reasons.push(`${c.record.callId}: scam would reach High later (${h0} → ${h1 ?? "never"})`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Drop the weight lessons a failed gate added, keep the rest of the update. */
export function withoutNewWeightLessons(pb: Playbook, update: PlaybookUpdate): Playbook {
  const out = structuredClone(pb);
  out.lessons = out.lessons.filter((l) => !(update.added.includes(l.id) && l.action.type === "adjust_weight"));
  return out;
}

// ---------------------------------------------------------------- consolidate (meaning, not wording)

export const CONSOLIDATE_MODEL = process.env.CONSOLIDATE_MODEL || "gemini-4-neon";

/**
 * Critics reviewing calls in parallel often write the same lesson in different words, which word
 * overlap can't see. A quick model pass groups same-meaning lessons; code merges them into the oldest
 * (seen counts add up, evidence is kept) and retires the rest. Structured lessons only merge with the
 * same action type; the model can only point at ids, never rewrite a lesson.
 */
export async function consolidate(pb: Playbook): Promise<{ playbook: Playbook; merged: string[] }> {
  const live = pb.lessons.filter((l) => l.status !== "retired");
  if (live.length < 2) return { playbook: pb, merged: [] };
  const prompt = `These are lessons in a playbook for an AI phone assistant. Some may say the same thing in different words.
Group lessons that would make the assistant do the SAME thing in the SAME situation. Lessons that differ in situation or action are not duplicates.
${live.map((l) => `${l.id} [${l.action.type}${l.action.type === "prefer_direction" ? ` ${l.action.category} when ${l.action.whenSigns.join("+")}` : l.action.type === "adjust_weight" ? ` ${l.action.sign} ${l.action.delta}` : ""}]: when ${l.when}: ${l.do}`).join("\n")}

Return JSON only: {"groups":[{"keep":"<id>","duplicates":["<id>"]}]}. Use an empty list if there are no duplicates.`;
  const r = await generateJson<{ groups?: unknown }>(CONSOLIDATE_MODEL, prompt, { timeoutMs: 45000, thinking: thinkingFor("CONSOLIDATE_THINKING", "low") });
  if (!r.ok) return { playbook: pb, merged: [] };
  const next = structuredClone(pb);
  const byId = new Map(next.lessons.map((l) => [l.id, l]));
  const merged: string[] = [];
  const kind = (l: Lesson) => (l.action.type === "planner_hint" || l.action.type === "detection_hint" ? "hint" : l.action.type);
  for (const g of Array.isArray(r.data?.groups) ? (r.data!.groups as { keep?: unknown; duplicates?: unknown }[]) : []) {
    const ids = [String(g?.keep ?? ""), ...(Array.isArray(g?.duplicates) ? g.duplicates.map(String) : [])];
    const group = [...new Set(ids)].map((id) => byId.get(id)).filter((l): l is Lesson => !!l && l.status !== "retired");
    if (group.length < 2) continue;
    // Keep the oldest; only merge lessons of the same kind (and identical structured actions).
    group.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    const [keep, ...rest] = group;
    for (const d of rest) {
      if (kind(d) !== kind(keep)) continue;
      if (kind(d) !== "hint" && JSON.stringify(d.action) !== JSON.stringify(keep.action)) continue;
      keep.seen += d.seen;
      keep.severity = Math.max(keep.severity, d.severity) as 1 | 2 | 3;
      keep.evidence = [...keep.evidence, ...d.evidence].slice(-8);
      if (keep.status === "candidate" && (d.status === "active" || keep.seen >= 2)) keep.status = "active";
      keep.updatedInVersion = next.version;
      d.status = "retired";
      merged.push(`${d.id}→${keep.id}`);
    }
  }
  if (merged.length) next.changelog.at(-1)!.note += `; merged duplicates ${merged.join(", ")}`;
  return { playbook: merged.length ? next : pb, merged };
}
