import { SIGNS, SIGN_IDS } from "../brain/catalog.ts";
import { generateJson, thinkingFor } from "../brain/llm.ts";
import { CATEGORIES, validateLesson } from "./playbook.ts";
import type { CallRecord, CriticReport, Finding, FindingType, JudgeMetrics, Playbook } from "./types.ts";

/**
 * The critic runs after hang-up with time to think. Gemini 4 Neon at high thinking by default:
 * the strongest Gemini 4 model we can call at volume (the learning rounds run it on every call).
 * Set CRITIC_MODEL=gemini-4-carbon for the deepest review if your key has it.
 */
export const CRITIC_MODEL = process.env.CRITIC_MODEL || "gemini-4-neon";

const FINDING_TYPES: FindingType[] = ["missed_sign", "late_sign", "false_alarm", "wrong_question", "right_question_wrong_time", "missed_question", "wasted_turn", "good_move"];

function annotatedTranscript(r: CallRecord) {
  const level = new Map(r.timeline.map((x) => [x.callerTurn, x]));
  const lastBoard = new Map<string, CallRecord["boards"][number]>();
  for (const b of r.boards) lastBoard.set(b.forCallerTurn, b); // the final board Alex saw for that line
  const spoken = new Map(r.spoken.map((s) => [s.turnId, s]));
  return r.turns
    .map((t) => {
      if (t.speaker === "caller") {
        const lv = level.get(t.turnId);
        const b = lastBoard.get(t.turnId);
        const cards = b ? b.directions.map((d) => `${d.suggested ? "*" : ""}${d.category}: "${d.say}"`).join(" | ") : "none";
        return `${t.turnId} CALLER: ${t.text}\n    [meter after this line: ${lv ? `${lv.level} (${lv.score})${lv.locked ? " LOCKED" : ""}` : "?"}] [cards offered (* = suggested): ${cards}]`;
      }
      if (t.speaker === "agent") {
        const s = spoken.get(t.turnId);
        const how = s?.category === "intro" ? "intro" : s?.directionId ? `from a ${s.wasSuggested ? "SUGGESTED" : "non-suggested"} ${s.category} card` : "other";
        return `${t.turnId} ASSISTANT (${how})${t.status === "cut" ? " [cut off by Alex]" : ""}: ${t.text}`;
      }
      return `${t.turnId} ALEX: ${t.text}`;
    })
    .join("\n");
}

function metricsText(m: JudgeMetrics) {
  return [
    `label (ground truth): ${m.label}`,
    `final level: ${m.finalLevel}${m.locked ? " (locked as confirmed)" : ""}; verdict correct: ${m.verdictCorrect ?? "unknown"}`,
    `false alarm: ${m.falseAlarm}; missed scam: ${m.missedScam}`,
    `caller lines: ${m.callerTurns}; reached High at caller line: ${m.reachedHighAt ?? "never"}; locked at: ${m.lockedAt ?? "never"}`,
    `money/code first requested at caller line: ${m.firstMoneyAt ?? "never"}`,
    `identity check or callback first SUGGESTED after caller line: ${m.firstCheckSuggestedAt ?? "never"}; first ASKED after caller line: ${m.firstCheckAskedAt ?? "never"}`,
    `check asked before money (scams): ${m.checkBeforeMoney ?? "n/a"}`,
    `assistant lines: ${m.agentQuestions}; repeated categories: ${m.repeatedCategories.join(", ") || "none"}; spoke private analysis or a code: ${m.leaks.join(", ") || "never"}`,
  ].join("\n");
}

export async function critique(r: CallRecord, m: JudgeMetrics, pb: Playbook): Promise<CriticReport> {
  const active = pb.lessons.filter((l) => l.status === "active");
  const unknown = r.label === "unknown";
  const prompt = `You are the CRITIC for ReVoice. ReVoice helps Alex with phone calls: an AI assistant can talk to the caller for Alex,
while models score scam risk (a meter: Low / Medium / High, locked when confirmed) and offer Alex 3 cards with the assistant's next line.
Alex taps a card and the assistant says it. Your job: review ONE finished call and write lessons that make the NEXT calls better.

Judge two things:
1. CLASSIFICATION: did the meter reach the right level, and how early? A scam should reach High as soon as the evidence allows;
   a legitimate call should never reach High.
2. QUESTIONING: were the right questions asked at the right time?
   Good practice for an unknown caller who claims to be someone Alex knows: verify identity (something only the real person knows,
   or a callback on the number Alex already has) BEFORE any money talk goes further. Once money or a payment method appears,
   offer the callback. Once a code is requested, decline. Never ask for something the caller already said.
   For legitimate and everyday calls, do NOT interrogate: help Alex decide (details, get it in writing, confirm corrected values).
   Wasted turns, repeated questions and late checks are mistakes; so is a good card that existed but wasn't the suggested one.

${unknown ? "The ground truth is UNKNOWN (Alex didn't say). Write findings and lessons about QUESTIONING and TIMING only: no adjust_weight and no detection_hint lessons.\n" : `Ground truth: this call was ${r.label === "scam" ? "a SCAM" : "LEGITIMATE"}. Trust it over the meter.\n`}
Call from ${r.from} (${r.inContacts ? "in Alex's contacts" : "NOT in Alex's contacts"}).

Annotated transcript:
${annotatedTranscript(r)}

Numbers computed by code (trust these):
${metricsText(m)}

Sign catalog (id: meaning, weight):
${SIGN_IDS.map((id) => `- ${id}: ${SIGNS[id].label} (${SIGNS[id].weight > 0 ? "+" : ""}${SIGNS[id].weight})`).join("\n")}
Score: Low 0-3, Medium 4-7, High 8+.
Card categories: ${CATEGORIES.join(", ")}.

Lessons already active (don't repeat one unless this call shows it again, in which case repeating it reinforces it):
${active.map((l) => `- ${l.id}: when ${l.when}: ${l.do} [${JSON.stringify(l.action)}]`).join("\n") || "- none yet"}

Write:
- "grades": 1-5 each for classification, questioning, timing (right question at the right moment), safety (assistant never paid, approved, shared codes or private analysis).
- "summary": 2 sentences: what went well, what most needs to change.
- "findings": up to 6. Each: type (${FINDING_TYPES.join(", ")}), turns (turn ids), whatHappened, shouldHave, severity 1-3 (3 = would have cost Alex money or a false accusation). Include at least one good_move if anything went right.
- "lessons": 0 to 3 rules for FUTURE calls. They must be general patterns that transfer to other callers: no names, no amounts, no numbers, no phone numbers.
  Each lesson: "when" (the situation), "do" (what to do differently), "severity" 1-3, "evidenceTurns" (turn ids from this call), and "action", exactly one of:
  {"type":"prefer_direction","category":"<card category>","whenSigns":["<1-3 sign ids>"],"notInContactsOnly":true|false}   make that card the suggested one when those signs are present
  {"type":"adjust_weight","sign":"<sign id>","delta":1 or -1}   only if a sign is clearly over- or under-weighted
  {"type":"planner_hint"}   advice on wording, order or timing of questions
  {"type":"detection_hint"}   advice on what does or does not count as a warning sign
  Prefer prefer_direction and adjust_weight over hints: they are enforced in code. Lessons can never change the safety rules
  (the assistant says it's an AI, never pays, approves or shares codes, never speaks as Alex, never ends the call).
  If the call went well, return no lessons.

Return JSON only:
{"grades":{"classification":0,"questioning":0,"timing":0,"safety":0},"summary":"","findings":[{"type":"","turns":[],"whatHappened":"","shouldHave":"","severity":1}],"lessons":[{"when":"","do":"","severity":1,"evidenceTurns":[],"action":{"type":""}}]}`;

  const res = await generateJson<{
    grades?: Record<string, unknown>;
    summary?: unknown;
    findings?: unknown;
    lessons?: unknown;
  }>(CRITIC_MODEL, prompt, { timeoutMs: Number(process.env.CRITIC_TIMEOUT_MS || 120000), thinking: thinkingFor("CRITIC_THINKING", "high") });

  const base = { callId: r.callId, model: CRITIC_MODEL, ms: res.ms };
  if (!res.ok || !res.data) {
    return { ...base, ok: false, error: res.error, grades: { classification: 0, questioning: 0, timing: 0, safety: 0 }, summary: `Critic failed: ${res.error}`, findings: [], proposed: [], rejected: [] };
  }
  const d = res.data;
  const ids = new Set(r.turns.map((t) => t.turnId));
  const grade = (k: string) => Math.max(1, Math.min(5, Math.round(Number(d.grades?.[k]) || 0))) || 1;
  const findings: Finding[] = (Array.isArray(d.findings) ? d.findings : [])
    .map((f: Partial<Finding> & { turns?: unknown }) => ({
      type: f?.type as FindingType,
      turns: (Array.isArray(f?.turns) ? f.turns : []).filter((t): t is string => ids.has(t as string)),
      whatHappened: String(f?.whatHappened ?? "").slice(0, 300),
      shouldHave: String(f?.shouldHave ?? "").slice(0, 300),
      severity: ([1, 2, 3].includes(Number(f?.severity)) ? Number(f?.severity) : 1) as 1 | 2 | 3,
    }))
    // A finding has to point at something that happened in this call.
    .filter((f) => FINDING_TYPES.includes(f.type) && f.turns.length && f.whatHappened)
    .slice(0, 6);

  const proposed: CriticReport["proposed"] = [];
  const rejected: string[] = [];
  for (const raw of (Array.isArray(d.lessons) ? d.lessons : []).slice(0, 3)) {
    const x = raw as { evidenceTurns?: unknown; when?: string; do?: string };
    const turns = (Array.isArray(x?.evidenceTurns) ? x.evidenceTurns : []).filter((t): t is string => ids.has(t as string));
    if (!turns.length) {
      rejected.push(`"${String(x?.do ?? "").slice(0, 50)}": cites no turn from this call`);
      continue;
    }
    if (/\$\s?\d|\d{3,}/.test(`${x?.when ?? ""} ${x?.do ?? ""}`)) {
      rejected.push(`"${String(x?.do ?? "").slice(0, 50)}": contains amounts or numbers (not general)`);
      continue;
    }
    const v = validateLesson({ ...(raw as object), evidence: [{ callId: r.callId, turns }] });
    if (!v.lesson) {
      rejected.push(`"${String(x?.do ?? "").slice(0, 50)}": ${v.reason}`);
      continue;
    }
    if (unknown && (v.lesson.action.type === "adjust_weight" || v.lesson.action.type === "detection_hint")) {
      rejected.push(`"${v.lesson.do.slice(0, 50)}": needs a labeled call`);
      continue;
    }
    proposed.push(v.lesson);
  }

  return {
    ...base,
    ok: true,
    grades: { classification: grade("classification"), questioning: grade("questioning"), timing: grade("timing"), safety: grade("safety") },
    summary: String(d.summary ?? "").slice(0, 500),
    findings,
    proposed,
    rejected,
  };
}
