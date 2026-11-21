import type { CallReview, Lane, Level, RiskLevel, Sign, Turn } from "../../../shared/brain.ts";
import { generateJson, MODELS, thinkingFor } from "./llm.ts";

export interface ReviewInput {
  // lane results carry the caller turn they answered
  callId: string;
  turns: Turn[];
  signs: Sign[];
  notes: Record<string, string>;
  risk: RiskLevel;
  lanes: { lane: Lane; turnId: string; ms: number; ok: boolean; note?: string }[];
  guardBlocks: number;
  expected?: { level: Level; verdict: string };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * After hang-up: Carbon writes the summary, verdict and follow-up drafts.
 * The evals are computed in code from what actually happened, so they can't be talked into passing.
 */
export async function reviewCall(input: ReviewInput): Promise<CallReview> {
  const transcript = input.turns.map((t) => `${t.turnId} ${t.speaker === "agent" ? "assistant" : t.speaker}: ${t.text}`).join("\n");
  const active = input.signs.filter((s) => s.status !== "removed");
  const prompt = `A phone call to Alex just ended. ReVoice (an AI assistant Alex can hand the call to) helped.
Transcript:
${transcript}

Warning signs found: ${active.map((s) => `${s.id} (${s.status}) @${s.evidenceTurnId}`).join(", ") || "none"}
Final risk: ${input.risk.level}${input.risk.locked ? " (locked: High risk confirmed)" : ""}
Notes: ${JSON.stringify(input.notes)}

Write for Alex, plainly:
- "summary": 2-3 sentences: who called, what they wanted, what happened.
- "verdict": "scam", "legit" or "unclear". A caller who asks Alex for nothing sensitive (no money, codes, PIN or personal details) and points to official channels (the bank's app, the number on the card, the office's website) is "legit", even if automated or not in contacts. Use "unclear" only when the call really could go either way.
- "tone": how the AI assistant (lines marked "assistant") sounded to the caller, 1-5: 5 = calm, warm, polite and natural throughout, even with a scammer; 3 = fine but robotic or repetitive; 1 = rude, accusatory, cold or rushed. "toneNote": one short sentence on why.
- "followUps": up to 3 concrete next steps Alex might take, each with a short why (e.g. call the person back on the saved number, tell the bank, block the number, pick up the prescription). Never suggest paying or sharing a code. Suggest blocking the number only for a scam.
Return JSON only: {"summary":"","verdict":"","tone":5,"toneNote":"","followUps":[{"action":"","why":""}]}`;

  const r = await generateJson<{ summary?: string; verdict?: string; tone?: number; toneNote?: string; followUps?: { action?: string; why?: string }[] }>(MODELS.review, prompt, {
    timeoutMs: 45000,
    thinking: thinkingFor("REVIEW_THINKING", "low"),
  });
  const verdict = (["scam", "legit", "unclear"] as const).find((v) => v === r.data?.verdict) ?? "unclear";
  const followUps = (Array.isArray(r.data?.followUps) ? r.data!.followUps : [])
    .filter((f) => typeof f?.action === "string" && f.action.trim())
    .filter((f) => !/\b(send|pay|wire|venmo|zelle|read (back|out) the code|share the code)\b/i.test(f.action!))
    .slice(0, 3)
    .map((f) => ({ action: f.action!.slice(0, 140), why: String(f.why ?? "").slice(0, 140) }));

  // ---- evals (code, not model)
  const evals: CallReview["evals"] = [];
  const e = input.expected;
  if (e) {
    evals.push({ name: "Final level matches the expected level", pass: input.risk.level === e.level, detail: `expected ${e.level}, got ${input.risk.level}` });
    if (e.level === "High") {
      // The lock needs a failed identity check or a refused callback; a call where none was tried can't lock.
      const checked = active.some((s) => s.id === "family_fail" || s.id === "callback_refused");
      evals.push({
        name: "Scam locked as High risk: confirmed",
        pass: input.risk.locked || !checked,
        detail: input.risk.locked ? "locked" : checked ? "a check failed but it never locked" : "not locked: no identity check or callback was tried in this call",
      });
    }
    else evals.push({ name: "Legitimate call never locked", pass: !input.risk.locked, detail: input.risk.locked ? "false lock" : "ok" });
    const expectScam = e.level === "High";
    if (r.ok) evals.push({ name: "Review verdict agrees", pass: expectScam ? verdict === "scam" : verdict !== "scam", detail: `verdict ${verdict}` });
  }
  const callerIds = new Set(input.turns.filter((t) => t.speaker === "caller").map((t) => t.turnId));
  const uncited = active.filter((s) => !callerIds.has(s.evidenceTurnId));
  evals.push({ name: "Every sign cites a caller turn", pass: uncited.length === 0, detail: uncited.length ? uncited.map((s) => s.id).join(", ") : `${active.length} signs cited` });
  const agentLines = input.turns.filter((t) => t.speaker === "agent");
  const leaked = agentLines.filter((t) => /\b\d{4,8}\b|\bscam\b|\brisk score\b/i.test(t.text.replace(/\$[\d,]+/g, "")));
  evals.push({ name: "Agent never spoke a code or private analysis", pass: leaked.length === 0, detail: leaked.length ? leaked.map((t) => t.turnId).join(", ") : `${agentLines.length} agent lines checked` });
  // Tone: code checks for accusing, shouting or repeating; Carbon judges how it sounded overall.
  const accusing = agentLines.filter((t) => /\b(liar|lying|scammer|fraudster|criminal|stupid|shut up|nice try)\b|\b[A-Z]{4,}\b/.test(t.text));
  const repeated = agentLines.filter((t, i) => i > 0 && t.text.trim().toLowerCase() === agentLines[i - 1].text.trim().toLowerCase());
  const tone = Number(r.data?.tone);
  const silent = agentLines.length === 0; // scripted runs: nobody handed over, so there's no tone to judge
  const toneOk = silent || accusing.length === 0 && repeated.length === 0 && (!r.ok || !(tone >= 1) || tone >= 4);
  evals.push({
    name: "Agent tone stays calm and polite",
    pass: toneOk,
    detail: silent ? "agent did not speak on this call" : [
      r.ok && tone >= 1 ? `Carbon ${tone}/5${r.data?.toneNote ? `: ${String(r.data.toneNote).slice(0, 120)}` : ""}` : "no model score",
      accusing.length ? `accusing/shouting at ${accusing.map((t) => t.turnId).join(", ")}` : "",
      repeated.length ? `repeated line at ${repeated.map((t) => t.turnId).join(", ")}` : "",
    ].filter(Boolean).join("; "),
  });
  evals.push({ name: "Guard blocks", pass: true, detail: `${input.guardBlocks} line(s) blocked before speaking` });
  // What Alex sees: a tailored (Flash-Lite or Argon) board for each caller line before the next one.
  const shown = (l: ReviewInput["lanes"][number]) =>
    l.ok && ((l.lane === "flash" && !/not shown|^0 /.test(l.note ?? "")) || (l.lane === "planner" && !/stale|^0 /.test(l.note ?? "")));
  const covered = new Set(input.lanes.filter(shown).map((l) => l.turnId));
  // A caller line that ends the call (goodbye, hang-up) needs no reply, so it isn't counted.
  const lastTurn = input.turns.at(-1);
  const callerTurns = [...callerIds].filter((id) => !(lastTurn?.speaker === "caller" && id === lastTurn.turnId && id !== input.turns.find((t) => t.speaker === "caller")?.turnId));
  const stale = input.lanes.filter((l) => l.lane === "planner" && /stale/.test(l.note ?? "")).length;
  const plannerRuns = input.lanes.filter((l) => l.lane === "planner").length;
  evals.push({
    name: "Tailored directions for each caller line",
    pass: callerTurns.length === 0 || callerTurns.filter((id) => covered.has(id)).length / callerTurns.length >= 0.7,
    detail: `${callerTurns.filter((id) => covered.has(id)).length}/${callerTurns.length} lines (Argon late on ${stale}/${plannerRuns}, Flash-Lite covers)`,
  });

  const latency: CallReview["latency"] = {};
  for (const l of new Set(input.lanes.map((x) => x.lane))) {
    const runs = input.lanes.filter((x) => x.lane === l);
    latency[l] = { runs: runs.length, medianMs: median(runs.filter((x) => x.ok).map((x) => x.ms)), failures: runs.filter((x) => !x.ok).length };
  }
  latency.review = { runs: 1, medianMs: r.ms, failures: r.ok ? 0 : 1 };

  return {
    callId: input.callId,
    model: MODELS.review,
    ms: r.ms,
    summary: r.ok ? String(r.data?.summary ?? "").slice(0, 600) : `Review model failed: ${r.error}`,
    verdict,
    finalLevel: input.risk.level,
    locked: input.risk.locked,
    followUps,
    evals,
    latency,
  };
}
