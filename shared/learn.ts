import type { DirectionCategory, Level, Sign, Turn } from "./brain.ts";

/**
 * The review phase: after hang-up, a call becomes a CallRecord, the judge scores it in code,
 * the critic (Gemini) explains what to do better, and its lessons go into the playbook the next call reads.
 */

export type Label = "scam" | "legit" | "unknown";

/** Everything that happened on one call, rebuilt from the call's event log. */
export interface CallRecord {
  callId: string;
  endedAt: string;
  source: "desk" | "phone" | "sim";
  scenarioId?: string;
  personaId?: string;
  from: string;
  inContacts: boolean;
  label: Label;
  labelSource: "scenario" | "persona" | "alex" | "none";
  playbookVersion: number;
  turns: Turn[];
  /** Risk as Alex saw it when each caller line was the newest one (last update before the next caller line). */
  timeline: { callerTurn: string; level: Level; score: number; locked: boolean }[];
  signs: Sign[];
  /** Every set of suggestion cards shown, keyed by the caller line it answered. */
  boards: { forCallerTurn: string; directions: { id: string; category: DirectionCategory; label: string; say: string; suggested: boolean; source: string }[] }[];
  /** What the agent actually said, and which card it came from. */
  spoken: { turnId: string; afterCallerTurn: string | null; category: DirectionCategory | "intro" | "other"; say: string; directionId: string | null; wasSuggested: boolean }[];
  notes: Record<string, string>;
  review?: { summary: string; verdict: string; evals: { name: string; pass: boolean; detail: string }[] };
  guardBlocks: number;
}

/** Hard numbers computed in code, so a model can't talk a call into passing. */
export interface JudgeMetrics {
  label: Label;
  finalLevel: Level;
  locked: boolean;
  verdictCorrect: boolean | null; // null when the label is unknown
  falseAlarm: boolean;
  missedScam: boolean;
  callerTurns: number;
  /** 1-based caller line where the meter first showed High, and where it locked. */
  reachedHighAt: number | null;
  lockedAt: number | null;
  firstMoneyAt: number | null;
  /** 1-based caller line after which the agent first asked an identity check or offered a callback. */
  firstCheckAskedAt: number | null;
  /** 1-based caller line whose board first *suggested* an identity check or callback. */
  firstCheckSuggestedAt: number | null;
  /** Scams: was a check asked no later than the line where money came up? */
  checkBeforeMoney: boolean | null;
  agentQuestions: number;
  repeatedCategories: DirectionCategory[];
  followedSuggestion: number; // spoken lines that came from the suggested card
  leaks: string[]; // agent turns that spoke a code, a score or "scam"
  guardBlocks: number;
}

export type FindingType =
  | "missed_sign" | "late_sign" | "false_alarm"
  | "wrong_question" | "right_question_wrong_time" | "missed_question" | "wasted_turn"
  | "good_move";

export interface Finding {
  type: FindingType;
  turns: string[];
  whatHappened: string;
  shouldHave: string;
  severity: 1 | 2 | 3;
}

/**
 * What a lesson is allowed to change. Anything else is rejected in code, so the critic can never
 * touch the safety rules (says it's an AI, never pays, approves or shares codes, only Alex ends the call).
 */
export type LessonAction =
  /** When all these signs are active, make this category the Suggested card (stock board) and tell the planner. */
  | { type: "prefer_direction"; category: DirectionCategory; whenSigns: string[]; notInContactsOnly?: boolean }
  /** Nudge a sign's weight by one point. Clamped to ±2 in total, and a sign never flips direction. */
  | { type: "adjust_weight"; sign: string; delta: 1 | -1 }
  /** Advice for the planner: wording, order and timing of questions. */
  | { type: "planner_hint" }
  /** Advice for the risk and supervisor lanes: what does or doesn't count as a sign. */
  | { type: "detection_hint" };

export interface Lesson {
  id: string; // "L-007"
  status: "candidate" | "active" | "retired";
  when: string; // the situation, in words
  do: string; // what to do differently, in words
  action: LessonAction;
  severity: 1 | 2 | 3;
  seen: number; // how many calls proposed it
  evidence: { callId: string; turns: string[] }[];
  addedInVersion: number;
  updatedInVersion: number;
}

export interface Playbook {
  version: number;
  updatedAt: string;
  lessons: Lesson[];
  /** Why each version exists, newest last. */
  changelog: { version: number; at: string; note: string }[];
}

export interface CriticReport {
  callId: string;
  model: string;
  ms: number;
  ok: boolean;
  error?: string;
  grades: { classification: number; questioning: number; timing: number; safety: number };
  summary: string;
  findings: Finding[];
  proposed: Omit<Lesson, "id" | "status" | "seen" | "addedInVersion" | "updatedInVersion">[];
  rejected: string[]; // lessons the validator threw out, with the reason
}

export interface PlaybookUpdate {
  fromVersion: number;
  toVersion: number;
  added: string[];
  reinforced: string[];
  promoted: string[];
  rejected: string[];
  /** Same-meaning lessons folded together ("L-005→L-003"). */
  merged?: string[];
}
