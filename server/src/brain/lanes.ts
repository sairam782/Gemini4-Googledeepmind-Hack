import type { Direction, DirectionCategory, Turn } from "../../../shared/brain.ts";
import { SIGNS, SIGN_IDS, guardSay } from "./catalog.ts";
import { generateJson, MODELS } from "./llm.ts";

export const NOTE_FIELDS = [
  "Says they are", "Calling from", "Story", "Request", "Amount", "How to pay",
  "Deadline", "Ready by", "Family question", "Callback", "Location",
];
const CATEGORIES: DirectionCategory[] = ["verify_identity", "offer_callback", "probe_details", "slow_down", "decline"];

const catalogText = SIGN_IDS.map((id) => `- ${id}: ${SIGNS[id].label}`).join("\n");
const transcriptText = (turns: Turn[]) =>
  turns.map((t) => `${t.turnId} ${t.speaker === "agent" ? "assistant" : t.speaker}: ${t.text}${t.status === "cut" ? " [cut off]" : ""}`).join("\n");
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

export interface CallContext {
  from: string;
  inContacts: boolean;
}
export interface SignHit {
  id: string;
  evidenceTurnId: string;
}

// ---------------------------------------------------------------- Hydrogen: fast check (signs on the newest turn)

export async function fastCheck(turns: Turn[], newest: Turn) {
  const prompt = `You flag scam warning signs in the NEWEST caller turn of a live phone call to Alex.
Judge only what is said, never how the voice sounds. Flag a sign only if it is clearly present in the newest caller turn.
Not warning signs: ordinary business hours or pickup windows ("by four", "within seven days"), and a caller correcting a price, date or detail they gave.

Allowed sign ids:
${catalogText}

Call so far:
${transcriptText(turns)}

Newest caller turn: ${newest.turnId}
Return JSON only: {"signs":[{"id":"<sign id>","evidenceTurnId":"${newest.turnId}"}]}. Use an empty list if none apply.`;
  const r = await generateJson<{ signs?: SignHit[] }>(MODELS.fast, prompt, { timeoutMs: 20000, thinking: "low" });
  const signs = arr<SignHit>(r.data?.signs).filter((s) => SIGN_IDS.includes(s?.id) && s.evidenceTurnId === newest.turnId);
  return { ...r, model: MODELS.fast, signs };
}

// ---------------------------------------------------------------- Planner (Hydrogen): the next 3 questions, every turn

export interface PlannerInput {
  ctx: CallContext;
  turns: Turn[];
  signs: string[]; // active sign ids
  notes: Record<string, string>;
  onScreen: Pick<Direction, "category" | "label">[];
  asked: DirectionCategory[];
  answered: DirectionCategory[];
}
export interface PlannerOutput {
  directions: Omit<Direction, "id" | "source" | "revision">[];
  answered: { category: DirectionCategory; evidenceTurnId: string }[];
  dropped: string[];
}

export async function plan(input: PlannerInput) {
  const prompt = `You write what Alex's AI assistant could say next on a live phone call. Alex reads your options privately and taps one.

WHO IS SPEAKING: an AI assistant that answered for Alex. It is NOT Alex and NOT family. It talks TO the caller and refers to Alex in the third person ("Alex", never "I" as Alex, never "our", "my mom", "before I send").
It never approves, agrees, pays, sends money or shares codes, never says it will end or hang up the call (only Alex does that), and never mentions notes, scores, warnings or scams.

Call: from ${input.ctx.from} (${input.ctx.inContacts ? "in Alex's contacts" : "NOT in Alex's contacts"}).
Transcript:
${transcriptText(input.turns)}

Warning signs so far: ${input.signs.join(", ") || "none"}
Notes: ${JSON.stringify(input.notes)}
On Alex's screen now: ${JSON.stringify(input.onScreen)}
Categories already asked: ${JSON.stringify(input.asked)}. Already answered: ${JSON.stringify(input.answered)}.

Write up to 3 options. Categories: ${CATEGORIES.join(", ")}.
- "say": the exact sentence, under 25 words, one question or statement, calm and polite.
- Unverified identity + money → prefer verify_identity ("Alex asked me to check: ...") or offer_callback (Alex calls back on the number Alex already has).
- A code or payment requested after a dodged or failed check → decline.
- Ordinary everyday calls → helpful details (what it covers, get it in writing, confirm a corrected value).
- Exactly one option has "suggested": true. Don't repeat an asked or answered category unless the caller dodged it.
- "answered": on-screen categories the caller already answered, with the turn id.

Return JSON only:
{"directions":[{"category":"","label":"","say":"","why":"","whyTurnId":"","suggested":false}],"answered":[{"category":"","evidenceTurnId":""}]}`;

  const r = await generateJson<Partial<PlannerOutput>>(MODELS.planner, prompt, { timeoutMs: 20000, thinking: "low" });
  if (!r.ok) return { ...r, model: MODELS.planner, out: null };
  const ids = new Set(input.turns.map((t) => t.turnId));
  const dropped: string[] = [];
  let directions = arr<PlannerOutput["directions"][number]>(r.data!.directions)
    .filter((x) => {
      if (!CATEGORIES.includes(x?.category) || typeof x?.say !== "string" || typeof x?.label !== "string") {
        dropped.push(`"${x?.label}": bad shape`);
        return false;
      }
      const blocked = guardSay(x.say);
      if (blocked) dropped.push(`"${x.label}": ${blocked}`);
      return !blocked;
    })
    .slice(0, 3)
    .map((x) => ({
      category: x.category,
      label: x.label.slice(0, 60),
      say: x.say.trim(),
      why: String(x.why ?? "").slice(0, 120),
      whyTurnId: ids.has(x.whyTurnId as string) ? x.whyTurnId : null,
      suggested: !!x.suggested,
    }));
  if (directions.length && directions.filter((x) => x.suggested).length !== 1) {
    directions = directions.map((x, i) => ({ ...x, suggested: i === 0 }));
  }
  const answered = arr<PlannerOutput["answered"][number]>(r.data!.answered).filter((a) => CATEGORIES.includes(a?.category) && ids.has(a?.evidenceTurnId));
  return { ...r, model: MODELS.planner, out: { directions, answered, dropped } as PlannerOutput };
}

// ---------------------------------------------------------------- Neon: analyst (confirms signs, notes, decision)

export interface AnalystInput {
  ctx: CallContext;
  turns: Turn[];
  provisional: SignHit[];
  notes: Record<string, string>;
}
export interface AnalystOutput {
  signs: SignHit[];
  notes: { field: string; value: string; evidenceTurnId: string }[];
  decision: { text: string; evidenceTurnId: string } | null;
  dropped: string[];
}

export async function analyze(input: AnalystInput) {
  const prompt = `You are the analyst for ReVoice, which helps Alex handle a live phone call. An AI assistant may speak to the caller for Alex.
Check the caller's STORY, never the voice.
Not warning signs: ordinary business hours or pickup windows ("by four", "within seven days"), and a caller correcting a price, date or detail they gave.

Call: from ${input.ctx.from} (${input.ctx.inContacts ? "in Alex's contacts" : "NOT in Alex's contacts"}).
Transcript:
${transcriptText(input.turns)}

1. "signs": every warning sign present anywhere in the caller's turns, each citing the caller turn where it first appears. Allowed ids:
${catalogText}
Provisional signs from a faster check (include to confirm, leave out to remove):
${input.provisional.map((s) => `- ${s.id} @ ${s.evidenceTurnId}`).join("\n") || "- none"}

2. "notes": the current value of each fact the caller stated, with the turn. Fields: ${NOTE_FIELDS.join(", ")}.
Current notes: ${JSON.stringify(input.notes)}. If a later turn corrects a value, give the corrected value and the correcting turn. Never guess.

3. "decision": what the caller wants Alex to decide, as a short question (e.g. "Send $900 by Venmo?"), with the turn, or null.

Return JSON only:
{"signs":[{"id":"","evidenceTurnId":""}],"notes":[{"field":"","value":"","evidenceTurnId":""}],"decision":{"text":"","evidenceTurnId":""}}`;

  const thinking = (process.env.ANALYST_THINKING as "low" | "high" | undefined) || "low";
  const r = await generateJson<Partial<AnalystOutput>>(MODELS.analyst, prompt, { timeoutMs: 45000, thinking });
  if (!r.ok) return { ...r, model: MODELS.analyst, out: null };
  const d = r.data!;
  const ids = new Set(input.turns.map((t) => t.turnId));
  const callerIds = new Set(input.turns.filter((t) => t.speaker === "caller").map((t) => t.turnId));
  const dropped: string[] = [];
  const signs = arr<SignHit>(d.signs).filter((s) => {
    const ok = SIGN_IDS.includes(s?.id) && callerIds.has(s?.evidenceTurnId);
    if (!ok) dropped.push(`sign ${s?.id}@${s?.evidenceTurnId}`);
    return ok;
  });
  const notes = arr<AnalystOutput["notes"][number]>(d.notes).filter((n) => {
    const ok = typeof n?.field === "string" && typeof n?.value === "string" && !!n.value.trim() && ids.has(n.evidenceTurnId);
    if (!ok) dropped.push(`note ${n?.field}`);
    return ok;
  }).slice(0, 12);
  const decision = d.decision && typeof d.decision.text === "string" && d.decision.text && ids.has(d.decision.evidenceTurnId) ? d.decision : null;
  return { ...r, model: MODELS.analyst, out: { signs, notes, decision, dropped } as AnalystOutput };
}
