import type { Direction, DirectionCategory, Turn } from "../../../shared/brain.ts";
import { SIGNS, SIGN_IDS, guardSay } from "./catalog.ts";
import { generateJson, MODELS, thinkingFor, type Thinking } from "./llm.ts";

export const NOTE_FIELDS = [
  "Says they are", "Calling from", "Story", "Request", "Amount", "How to pay",
  "Deadline", "Ready by", "Family question", "Callback", "Location",
];
const CATEGORIES: DirectionCategory[] = ["verify_identity", "offer_callback", "probe_details", "slow_down", "decline"];
const NOT_SIGNS =
  'Not warning signs: ordinary business hours or pickup windows ("by four", "within seven days"), and a caller correcting a price, date or detail they gave.';

const catalogText = SIGN_IDS.map((id) => `- ${id}: ${SIGNS[id].label}`).join("\n");
const transcriptText = (turns: Turn[]) =>
  turns.map((t) => `${t.turnId} ${t.speaker === "agent" ? "assistant" : t.speaker}: ${t.text}${t.status === "cut" ? " [cut off]" : ""}`).join("\n");
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const callLine = (ctx: CallContext) => `Call: from ${ctx.from} (${ctx.inContacts ? "in Alex's contacts" : "NOT in Alex's contacts"}).`;

export interface CallContext {
  from: string;
  inContacts: boolean;
}
export interface SignHit {
  id: string;
  evidenceTurnId: string;
}

// ---------------------------------------------------------------- Risk (Hydrogen): signs on the newest turn

export async function riskCheck(turns: Turn[], newest: Turn) {
  const prompt = `You flag scam warning signs in the NEWEST caller turn of a live phone call to Alex.
Judge only what is said, never how the voice sounds. Flag a sign only if it is clearly present in the newest caller turn.
${NOT_SIGNS}

Allowed sign ids:
${catalogText}

Call so far:
${transcriptText(turns)}

Newest caller turn: ${newest.turnId}
Return JSON only: {"signs":[{"id":"<sign id>","evidenceTurnId":"${newest.turnId}"}]}. Use an empty list if none apply.`;
  const r = await generateJson<{ signs?: SignHit[] }>(MODELS.risk, prompt, { timeoutMs: 20000, thinking: thinkingFor("RISK_THINKING", "low") });
  const signs = arr<SignHit>(r.data?.signs).filter((s) => SIGN_IDS.includes(s?.id) && s.evidenceTurnId === newest.turnId);
  return { ...r, model: MODELS.risk, signs };
}

// ---------------------------------------------------------------- Planner (Argon) and fast lane (Flash-Lite): next 3 directions

export interface PlannerInput {
  ctx: CallContext;
  turns: Turn[];
  signs: string[]; // active sign ids
  notes: Record<string, string>;
  onScreen: Pick<Direction, "category" | "label">[];
  asked: DirectionCategory[];
  answered: DirectionCategory[];
  strategy?: { text: string; turnId: string } | null; // Argon's private plan, carried to the next turn
}
export interface PlannerOutput {
  directions: Omit<Direction, "id" | "source" | "revision">[];
  answered: { category: DirectionCategory; evidenceTurnId: string }[];
  strategy: string; // planner lane only: one-sentence plan for the next lines
  dropped: string[];
}

const PLANNER_OPTS = {
  planner: () => ({ model: MODELS.planner, timeoutMs: 20000, thinking: thinkingFor("PLANNER_THINKING", "low") }),
  flash: () => ({ model: MODELS.flash, timeoutMs: 8000, thinking: thinkingFor("FLASH_THINKING", undefined) }),
};

export async function plan(input: PlannerInput, lane: "planner" | "flash" = "planner") {
  const opts = PLANNER_OPTS[lane]();
  const prompt = `You write what Alex's AI assistant could say next on a live phone call. Alex reads your options privately and taps one.

WHO IS SPEAKING: an AI assistant that answered for Alex. It is NOT Alex and NOT family. It talks TO the caller and refers to Alex in the third person ("Alex", never "I" as Alex, never "our", "my mom", "before I send").
It never approves, agrees, pays, sends money or shares codes, never says it will end or hang up the call (only Alex does that), and never mentions notes, scores, warnings or scams.

${callLine(input.ctx)}
Transcript:
${transcriptText(input.turns)}

Warning signs so far: ${input.signs.join(", ") || "none"}
Notes: ${JSON.stringify(input.notes)}
On Alex's screen now: ${JSON.stringify(input.onScreen)}
Categories already asked: ${JSON.stringify(input.asked)}. Already answered: ${JSON.stringify(input.answered)}.
${input.strategy ? `Strategy from the senior planner (written after ${input.strategy.turnId}; follow it if it still fits): ${input.strategy.text}
` : ""}
Always write exactly 3 options, even if the screen already has good ones (refresh them for the newest line). Categories: ${CATEGORIES.join(", ")}.
- "say": the exact sentence, under 25 words, one question or statement, calm and polite.
- Family checks ask about Alex in the third person ("Alex asked me to check: what was the name of Alex's first pet?"), never "we" or "our".
- Unverified identity + money → prefer verify_identity ("Alex asked me to check: ...") or offer_callback (Alex calls back on the number Alex already has).
- A code or payment requested after a dodged or failed check → decline.
- Ordinary everyday calls → helpful details (what it covers, get it in writing, confirm a corrected value).
- Exactly one option has "suggested": true. Don't repeat an asked or answered category unless the caller dodged it.
- "answered": on-screen categories the caller already answered, with the turn id.
${lane === "planner" ? `- "strategy": one private sentence for the faster assistant that writes the next lines: which check or trap to use next and why (e.g. "Caller dodged the family check; push the callback, then decline").
` : ""}
Return JSON only:
{"directions":[{"category":"","label":"","say":"","why":"","whyTurnId":"","suggested":false}],"answered":[{"category":"","evidenceTurnId":""}]${lane === "planner" ? ',"strategy":""' : ""}}`;

  const r = await generateJson<Partial<PlannerOutput>>(opts.model, prompt, { timeoutMs: opts.timeoutMs, thinking: opts.thinking });
  if (!r.ok) return { ...r, model: opts.model, out: null };
  const ids = new Set(input.turns.map((t) => t.turnId));
  const dropped: string[] = [];
  // Small models sometimes return the bare list instead of {"directions": [...]}.
  const rawDirs = Array.isArray(r.data) ? r.data : r.data!.directions;
  let directions = arr<PlannerOutput["directions"][number]>(rawDirs)
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
  if (!directions.length && !dropped.length) dropped.push(`empty: ${JSON.stringify(r.data).slice(0, 160)}`);
  if (directions.length && directions.filter((x) => x.suggested).length !== 1) {
    directions = directions.map((x, i) => ({ ...x, suggested: i === 0 }));
  }
  const answered = arr<PlannerOutput["answered"][number]>(Array.isArray(r.data) ? [] : r.data!.answered).filter((a) => CATEGORIES.includes(a?.category) && ids.has(a?.evidenceTurnId));
  const strategy = Array.isArray(r.data) ? "" : String(r.data!.strategy ?? "").trim().slice(0, 240);
  return { ...r, model: opts.model, out: { directions, answered, dropped, strategy } as PlannerOutput };
}

// ---------------------------------------------------------------- Notes (Hydrogen): facts with corrections, open decision

export interface NotesInput {
  ctx: CallContext;
  turns: Turn[];
  notes: Record<string, string>;
}
export interface NotesOutput {
  notes: { field: string; value: string; evidenceTurnId: string }[];
  decision: { text: string; evidenceTurnId: string } | null;
  dropped: string[];
}

export async function takeNotes(input: NotesInput) {
  const prompt = `You keep Alex's private notes during a live phone call. Record only facts the CALLER stated.

${callLine(input.ctx)}
Transcript:
${transcriptText(input.turns)}

1. "notes": the current value of each fact, with the caller turn that states it. Fields: ${NOTE_FIELDS.join(", ")}.
Current notes: ${JSON.stringify(input.notes)}. If a later turn corrects a value, give the corrected value and the correcting turn. Never guess; leave out fields nobody mentioned.
2. "decision": what the caller wants Alex to decide, as a short question (e.g. "Send $900 by Venmo?"), with the turn, or null.

Return JSON only:
{"notes":[{"field":"","value":"","evidenceTurnId":""}],"decision":{"text":"","evidenceTurnId":""}}`;
  const r = await generateJson<{ notes?: unknown; decision?: { text?: string; evidenceTurnId?: string } }>(MODELS.notes, prompt, {
    timeoutMs: 20000,
    thinking: thinkingFor("NOTES_THINKING", "low"),
  });
  if (!r.ok) return { ...r, model: MODELS.notes, out: null };
  const ids = new Set(input.turns.map((t) => t.turnId));
  const dropped: string[] = [];
  const notes = arr<NotesOutput["notes"][number]>(r.data!.notes).filter((n) => {
    const ok = typeof n?.field === "string" && typeof n?.value === "string" && !!n.value.trim() && ids.has(n.evidenceTurnId);
    if (!ok) dropped.push(`note ${n?.field}`);
    return ok;
  }).slice(0, 12);
  const d = r.data!.decision;
  const decision = d && typeof d.text === "string" && d.text && ids.has(d.evidenceTurnId as string) ? (d as NotesOutput["decision"]) : null;
  return { ...r, model: MODELS.notes, out: { notes, decision, dropped } as NotesOutput };
}

// ---------------------------------------------------------------- Supervisor (Neon): confirms signs, vetoes directions

export interface SupervisorInput {
  ctx: CallContext;
  turns: Turn[];
  provisional: SignHit[];
  onScreen: Pick<Direction, "id" | "label" | "say">[];
}
export interface SupervisorOutput {
  signs: SignHit[];
  withdraw: { directionId: string; reason: string }[];
  dropped: string[];
}

export async function supervise(input: SupervisorInput) {
  const prompt = `You supervise ReVoice, which helps Alex handle a live phone call. An AI assistant may speak to the caller for Alex.
Check the caller's STORY across the whole call, never the voice.
${NOT_SIGNS}

${callLine(input.ctx)}
Transcript:
${transcriptText(input.turns)}

1. "signs": every warning sign present anywhere in the caller's turns, each citing the caller turn where it first appears. Allowed ids:
${catalogText}
Provisional signs from faster lanes (include to confirm, leave out to remove):
${input.provisional.map((s) => `- ${s.id} @ ${s.evidenceTurnId}`).join("\n") || "- none"}

2. "withdraw": suggested lines on Alex's screen that would now be unsafe or pointless (already answered, helps a likely scammer, or contradicts the call). Usually empty.
On screen: ${JSON.stringify(input.onScreen)}

Return JSON only:
{"signs":[{"id":"","evidenceTurnId":""}],"withdraw":[{"directionId":"","reason":""}]}`;

  const r = await generateJson<Partial<SupervisorOutput>>(MODELS.supervisor, prompt, { timeoutMs: 45000, thinking: thinkingFor("SUPERVISOR_THINKING", thinkingFor("ANALYST_THINKING", "low")) });
  if (!r.ok) return { ...r, model: MODELS.supervisor, out: null };
  const callerIds = new Set(input.turns.filter((t) => t.speaker === "caller").map((t) => t.turnId));
  const screenIds = new Set(input.onScreen.map((d) => d.id));
  const dropped: string[] = [];
  const signs = arr<SignHit>(r.data!.signs).filter((s) => {
    const ok = SIGN_IDS.includes(s?.id) && callerIds.has(s?.evidenceTurnId);
    if (!ok) dropped.push(`sign ${s?.id}@${s?.evidenceTurnId}`);
    return ok;
  });
  const withdraw = arr<SupervisorOutput["withdraw"][number]>(r.data!.withdraw)
    .filter((w) => screenIds.has(w?.directionId) && typeof w.reason === "string")
    .map((w) => ({ directionId: w.directionId, reason: w.reason.slice(0, 80) }));
  return { ...r, model: MODELS.supervisor, out: { signs, withdraw, dropped } as SupervisorOutput };
}
