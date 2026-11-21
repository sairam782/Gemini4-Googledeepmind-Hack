import type { DeskServerMsg, Direction, DirectionCategory, Level, Turn } from "../../../shared/brain.ts";
import { SIGNS } from "../brain/catalog.ts";
import type { CallRecord, JudgeMetrics, Label } from "./types.ts";

export interface RecordMeta {
  callId: string;
  source: CallRecord["source"];
  from: string;
  inContacts: boolean;
  label: Label;
  labelSource: CallRecord["labelSource"];
  playbookVersion: number;
  alexLabel?: Label;
  scenarioId?: string;
  personaId?: string;
  guardBlocks: number;
}

/** Rebuild what happened on a call from its event log (the same events the desk and the app see). */
export function buildRecord(history: DeskServerMsg[], meta: RecordMeta): CallRecord {
  const turns = new Map<string, Turn>();
  const signs = new Map<string, CallRecord["signs"][number]>();
  const timeline = new Map<string, CallRecord["timeline"][number]>();
  const boards: CallRecord["boards"] = [];
  const spoken: CallRecord["spoken"] = [];
  const notes: Record<string, string> = {};
  const directionById = new Map<string, Direction>();
  let callerTurn: string | null = null;
  let review: CallRecord["review"];

  for (const m of history) {
    switch (m.type) {
      case "turn.final":
        turns.set(m.turn.turnId, { ...m.turn });
        if (m.turn.speaker === "caller") callerTurn = m.turn.turnId;
        break;
      case "agent.cut": {
        const t = turns.get(m.turnId);
        if (t) t.status = "cut";
        break;
      }
      case "risk.signal":
        signs.set(m.sign.id, { ...m.sign });
        break;
      case "risk.level":
        if (callerTurn) timeline.set(callerTurn, { callerTurn, level: m.risk.level, score: m.risk.score, locked: m.risk.locked });
        break;
      case "directions":
        m.directions.forEach((d) => directionById.set(d.id, d));
        if (m.directions.length && callerTurn)
          boards.push({ forCallerTurn: callerTurn, directions: m.directions.map((d) => ({ id: d.id, category: d.category, label: d.label, say: d.say, suggested: d.suggested, source: d.source })) });
        break;
      case "agent.say": {
        const d = m.directionId ? directionById.get(m.directionId) : undefined;
        spoken.push({
          turnId: m.turnId,
          afterCallerTurn: callerTurn,
          category: d ? d.category : m.directionId === null && !spoken.length ? "intro" : "other",
          say: m.text,
          directionId: m.directionId,
          wasSuggested: !!d?.suggested,
        });
        break;
      }
      case "notes.update":
        notes[m.field] = m.value;
        break;
      case "call.review":
        review = { summary: m.review.summary, verdict: m.review.verdict, evals: m.review.evals };
        break;
    }
  }

  // Carry the level forward for caller lines that produced no risk.level of their own.
  const callerIds = [...turns.values()].filter((t) => t.speaker === "caller").map((t) => t.turnId);
  let last: CallRecord["timeline"][number] = { callerTurn: "", level: "Low", score: 0, locked: false };
  const filled = callerIds.map((id) => (last = timeline.get(id) ?? { ...last, callerTurn: id }));

  return {
    ...meta,
    endedAt: new Date().toISOString(),
    turns: [...turns.values()].sort((a, b) => a.n - b.n),
    timeline: filled,
    signs: [...signs.values()],
    boards,
    spoken,
    notes,
    review,
  };
}

const CHECKS: DirectionCategory[] = ["verify_identity", "offer_callback"];

/** The judge: plain numbers from the record. No model involved. */
export function judge(r: CallRecord): JudgeMetrics {
  const callerIds = r.turns.filter((t) => t.speaker === "caller").map((t) => t.turnId);
  const idx = (turnId: string | null) => (turnId ? callerIds.indexOf(turnId) + 1 || null : null);
  const final = r.timeline.at(-1) ?? { level: "Low" as Level, locked: false };
  const highAt = r.timeline.findIndex((x) => x.level === "High");
  const lockAt = r.timeline.findIndex((x) => x.locked);
  const money = r.signs.filter((s) => (s.id === "money" || s.id === "code") && s.status !== "removed").map((s) => idx(s.evidenceTurnId) ?? Infinity);
  const firstMoneyAt = money.length ? Math.min(...money) : null;
  const asked = r.spoken.filter((s) => CHECKS.includes(s.category as DirectionCategory));
  const firstCheckAskedAt = asked.length ? idx(asked[0].afterCallerTurn) ?? 0 : null;
  const suggested = r.boards.find((b) => b.directions.some((d) => d.suggested && CHECKS.includes(d.category)));
  const cats = r.spoken.map((s) => s.category).filter((c): c is DirectionCategory => c !== "intro" && c !== "other");
  const repeated = [...new Set(cats.filter((c, i) => cats.indexOf(c) !== i && c !== "decline"))];
  const leaks = r.spoken.filter((s) => /\b\d{4,8}\b|\bscam\b|\brisk score\b/i.test(s.say.replace(/\$[\d,]+/g, ""))).map((s) => s.turnId);
  const scamCalled = final.level === "High";
  const verdictCorrect = r.label === "unknown" ? null : r.label === "scam" ? scamCalled : !scamCalled;
  return {
    label: r.label,
    finalLevel: final.level,
    locked: final.locked,
    verdictCorrect,
    falseAlarm: r.label === "legit" && scamCalled,
    missedScam: r.label === "scam" && !scamCalled,
    callerTurns: callerIds.length,
    reachedHighAt: highAt >= 0 ? highAt + 1 : null,
    lockedAt: lockAt >= 0 ? lockAt + 1 : null,
    firstMoneyAt,
    firstCheckAskedAt,
    firstCheckSuggestedAt: suggested ? idx(suggested.forCallerTurn) : null,
    checkBeforeMoney: r.label !== "scam" || firstMoneyAt === null ? null : firstCheckAskedAt !== null && firstCheckAskedAt <= firstMoneyAt,
    agentQuestions: r.spoken.filter((s) => s.category !== "intro").length,
    repeatedCategories: repeated,
    followedSuggestion: r.spoken.filter((s) => s.wasSuggested).length,
    leaks,
    guardBlocks: r.guardBlocks,
  };
}

export const signLabel = (id: string) => SIGNS[id]?.label ?? id;
