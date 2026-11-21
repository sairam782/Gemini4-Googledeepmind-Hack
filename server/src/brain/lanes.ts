import type { Direction, DirectionCategory, Turn } from "../../../shared/brain.ts";
import { SIGNS, SIGN_IDS, guardSay } from "./catalog.ts";
import { generateJson, MODELS, thinkingFor, type Thinking } from "./llm.ts";

export const NOTE_FIELDS = [
  "Says they are", "Calling from", "Story", "Request", "Amount", "How to pay",
  "Deadline", "Ready by", "Family question", "Callback", "Location",
];
const CATEGORIES: DirectionCategory[] = ["verify_identity", "offer_callback", "probe_details", "slow_down", "decline", "take_message"];
const NOT_SIGNS =
  'Not warning signs: ordinary business hours or pickup windows ("by four", "within seven days"), a caller correcting a price, date or detail they gave, and a real alert telling Alex to check the app or call the number on the card (that is not authority_threat).';

const catalogText = SIGN_IDS.map((id) => `- ${id}: ${SIGNS[id].label}`).join("\n");
const transcriptText = (turns: Turn[]) =>
  turns.map((t) => `${t.turnId} ${t.speaker === "agent" ? "assistant" : t.speaker}: ${t.text}${t.status === "cut" ? " [cut off]" : ""}`).join("\n");
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9$' ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const sentences = (t: string) => t.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [t];
/** Share of the smaller line's words that also appear in the other line. */
const overlap = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
};
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
  planner: () => ({ model: MODELS.planner, timeoutMs: 15000, thinking: thinkingFor("PLANNER_THINKING", "low") }),
  flash: () => ({ model: MODELS.flash, timeoutMs: 8000, thinking: thinkingFor("FLASH_THINKING", undefined) }),
};

export async function plan(input: PlannerInput, lane: "planner" | "flash" = "planner") {
  const opts = PLANNER_OPTS[lane]();
  const newest = [...input.turns].reverse().find((t) => t.speaker === "caller");
  const prompt = `You script the next spoken line for Alex's AI phone assistant, live, mid-call. The assistant answered Alex's phone and is talking to the caller right now. Alex sees your 3 options and taps one; if Alex doesn't tap within a few seconds, the assistant SAYS your highest-confidence option out loud. So every option must sound natural spoken right now, in reply to what the caller just said.

THE ASSISTANT'S VOICE
- An AI assistant speaking FOR Alex: "Alex", "Alex's", "I'll let Alex know". Never speaks as Alex or family (no "our", "we used to", "my mom").
- Warm, calm, brief, like a capable receptionist. Contractions. 6 to 22 words. One question or one statement per line.
- Never start with a greeting ("Hi", "Hello") or re-introduce the assistant; it already introduced itself.
- Vary the wording: don't start every line with "Alex will" or "Alex won't", and don't reuse the previous line's sentence.
- Keep pronouns consistent ("call Maya on the number Alex has saved for her"), and don't say "Alex" twice in one sentence when "the card" or "her" works.
- You don't know Alex's private facts, so never say an answer "didn't match" or was "wrong"; react to the hesitation or dodge instead ("since you weren't sure").
- Refuse only what was actually asked: mention codes only if a code was asked for, money only if money was asked for. Name it specifically ("the $900 to Jordan").
- If the caller already rejected the callback, don't offer it again word for word; move to a clear decline of their exact request.
- On routine calls keep it casual: a pickup time is not a "deadline".
- Start by reacting to the caller's newest line (acknowledge, answer a fair question, or name the dodge politely), then make the move.
- Use the call's specifics: names, amounts, dates, places ("the $900 for the tow", "Friday pickup").
- Never ask the caller for, or about, account numbers, card digits, PINs, passwords, codes, addresses or other personal details, even "just the last four". The assistant gives nothing and collects nothing sensitive.
- Callbacks are always on a number Alex already has: "the number Alex has saved for Maya", "the number on the back of the card", "the shop's number". Never "your usual number" or a number the caller offers.
- Never: approve, agree, pay, promise money, read or ask to hear codes being shared, say it will hang up or end the call, or use the words "scam", "note", "private", "approve", "deal", "warning".

WHAT TO DO (read the whole call, then the caller's newest line ${newest ? `${newest.turnId}: "${newest.text}"` : ""})
- Real or routine calls (pharmacy, doctor, a known shop, an alert that asks for nothing): be helpful, not suspicious. Confirm the key detail back, ask one useful practical question, or take the message ("take_message": "Got it, Tuesday at 10. I'll pass that to Alex."). Never interrogate them.
- Everyday decisions (an estimate, a booking): confirm corrected values, ask for it in writing, say Alex will decide or call back. Never say yes for Alex.
- Real bank alerts ask for nothing and point to the app or the card's number: thank them, confirm the detail, take_message.
- Unknown caller claiming to be family or a bank, asking for money, codes or secrecy, or threatening a freeze: climb this ladder, one rung per line, never repeating a rung the caller already got:
  1. verify_identity: ask something only the real person would know, about Alex in the third person ("Alex asked me to check: what's the name of Alex's dog?"). For a bank, agency or company there is no quiz: skip to rung 2.
  2. offer_callback: Alex will call back on the number Alex already has (for a bank: the number on the back of the card).
  3. decline: calm, firm no to exactly what they asked for, with the safe path ("Alex won't send the $900 to Jordan on this call. Alex will reach Maya on the number Alex has saved.").
  Dodged, wrong or angry answer to a rung = move UP a rung and say so kindly ("I hear you're in a hurry, but..."). A code request at any point = decline now.
- slow_down when the caller pushes a deadline; probe_details when the request is still unclear.

FORMAT OF THE 3 OPTIONS
- Option 1: the best next line ("suggested": true). Option 2: a good alternative. Option 3: a safe fallback (for risky calls, the firmest safe line).
- "confidence" 0.0 to 1.0: how sure you are this exact line is right to say NOW. Be calibrated: the best line on a clear call 0.85+, a decent alternative 0.5-0.7, a line that doesn't fit the newest turn below 0.4.
- "why": a few words for Alex. "whyTurnId": the turn it reacts to.
- "answered": categories already on screen that the caller has now answered, with the turn id.

GOOD vs BAD (caller: "Why are you asking me that? There's no time, please!")
- GOOD offer_callback: "I understand it's urgent. Since you weren't sure, Alex will call Maya on the number Alex has saved for her."
- BAD: "Can you tell me something only you and Alex would know?" (repeats a rung the caller just dodged)
GOOD vs BAD (pharmacy: "We'll hold it for seven days, no payment needed.")
- GOOD take_message: "Perfect, seven days, no payment. I'll let Alex know it's ready. Thanks for calling!"
- BAD verify_identity: "Can you prove who you are?" (interrogates a routine call)

${callLine(input.ctx)}
Transcript:
${transcriptText(input.turns)}

Warning signs so far: ${input.signs.join(", ") || "none"}
Facts from the caller: ${JSON.stringify(input.notes)}
On Alex's screen now: ${JSON.stringify(input.onScreen)}
The assistant's last lines (don't reuse their opening words like "Got it" / "I hear" or their closing like "I'll pass that to Alex"; a reply can simply answer, e.g. "Friday works, thanks for the heads-up."): ${JSON.stringify(input.turns.filter((t) => t.speaker === "agent").slice(-3).map((t) => t.text))}
Lines the assistant already used (categories): ${JSON.stringify(input.asked)}. Answered by the caller: ${JSON.stringify(input.answered)}.
${input.strategy ? `Strategy from the senior planner (written after ${input.strategy.turnId}; follow it if it still fits the newest line): ${input.strategy.text}
` : ""}Categories: ${CATEGORIES.join(", ")}.
${lane === "planner" ? `"strategy": one private sentence for the faster model that writes the next lines: which rung or move comes next and why (e.g. "Caller dodged the family check; push the callback, then decline").
` : ""}
Return JSON only:
{"directions":[{"category":"","label":"<2-5 words for Alex>","say":"","why":"","whyTurnId":"","suggested":true,"confidence":0.9}],"answered":[{"category":"","evidenceTurnId":""}]${lane === "planner" ? ',"strategy":""' : ""}}`;

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
      confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.5)),
    }));
  // Near-repeats of what the agent already said sound robotic (the tone eval flags them): drop them,
  // unless that would leave nothing to say.
  // Checked per sentence too: "Alex won't be rushed. Alex will call the number on the card." becomes
  // "Alex won't be rushed." when the card line was already said.
  const agentText = input.turns.filter((t) => t.speaker === "agent").map((t) => t.text);
  const said = agentText.map(words);
  const saidSentences = agentText.flatMap(sentences).map(words).filter((w) => w.size >= 4);
  const fresh = directions
    .map((x) => {
      const kept = sentences(x.say).filter((sn) => {
        const w = words(sn);
        return w.size < 4 || !saidSentences.some((p) => overlap(w, p) >= 0.75);
      });
      return kept.length && kept.length < sentences(x.say).length ? { ...x, say: kept.join(" ") } : x;
    })
    .filter((x) => {
      const repeat = said.some((w) => overlap(words(x.say), w) >= 0.7);
      if (repeat) dropped.push(`"${x.label}": repeats an earlier line`);
      return !repeat;
    });
  if (fresh.length) directions = fresh;
  else if (directions.length) {
    // Everything repeats (a scammer asking the same thing again): repeat once, briefly, like a person would.
    const first = directions.find((x) => x.suggested) ?? directions[0];
    const sentence = first.say.match(/^[^.!?]+[.!?]/)?.[0] ?? first.say;
    directions = [{ ...first, say: `Like I said, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`, suggested: true }];
  }
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
