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
  /** Alex's answer to "Was this a scam?" when the call also has a known answer (test calls). The critic sees it as a hint only. */
  alexLabel?: Label;
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
  /** The critic's OWN call, made from the transcript before it sees anyone's label. */
  ownVerdict?: { call: "scam" | "legit" | "unclear"; confidence: number; reasons: string; evidence: string[] };
  /** Alex's answer to "Was this a scam?", if any, and what the critic made of it. Advisory only. */
  alexOpinion?: { label: Label; agrees: boolean; note: string };
  /** Grades as the model gave them, before code caps. */
  rawGrades?: { classification: number; questioning: number; timing: number; safety: number };
  /** Hard facts that capped a grade ("timing ≤ 2: money was asked before any identity check"). */
  caps?: string[];
  /** Final grades, 1-5: the model's, capped by hard facts. */
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

// ---------------------------------------------------------------- eval suite (server/src/learn/evals.ts)

export interface ScoreBreakdown {
  verdict: number; // 30: the meter ended where it should (scam → High, legit → not High)
  detection: number; // 20: scams: how early it reached High; legit: never reached High
  checkTiming: number; // 15: scams: identity check or callback before money; legit: no repeated questions
  critic: number; // 25: the strict critic's questioning + timing grades
  safety: number; // 10: nothing leaked, nothing blocked
}

export interface SuiteCall {
  n: number;
  callId: string;
  persona: string;
  kind: "scam" | "legit";
  playbookLessons: number; // active lessons this call started with
  score: number;
  parts: ScoreBreakdown;
  delta: number | null; // vs the previous call
  trend: "first" | "better" | "same" | "worse";
  metrics: Pick<JudgeMetrics, "finalLevel" | "locked" | "verdictCorrect" | "reachedHighAt" | "firstMoneyAt" | "firstCheckAskedAt" | "checkBeforeMoney" | "agentQuestions" | "callerTurns">;
  grades: CriticReport["grades"];
  ownVerdict: CriticReport["ownVerdict"] | null;
  criticAgreesWithTruth: boolean | null;
  summary: string;
  caps: string[];
  lessonsAdded: { id: string; when: string; do: string }[];
  ms: number;
}

export interface SuiteRun {
  kind: "suite";
  name: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  error?: string;
  persona: string[];
  criticModel: string;
  callerModel: string;
  startPlaybook: "empty" | "current";
  calls: SuiteCall[];
  result: null | { first: number; last: number; best: number; improvedSteps: number; steps: number; monotonic: boolean; passed: boolean };
}

