import type { DirectionCategory, Level, RiskLevel, Sign } from "../../../shared/brain.ts";

/** Sign catalog and fixed weights from the v3 plan. Models detect signs; code scores them. */
export const SIGNS: Record<string, { label: string; weight: number }> = {
  money: { label: "Asks for money or a payment", weight: 3 },
  code: { label: "Asks for a code, password or account detail", weight: 4 },
  family_fail: { label: "Dodges or fails the family question", weight: 3 },
  callback_refused: { label: "Refuses a callback on the saved number", weight: 3 },
  third_party_pay: { label: "Pays someone else, gift cards, crypto or wire", weight: 2 },
  deadline: { label: "Pressure to act within minutes (\"right now\", \"no time\")", weight: 2 },
  emergency: { label: "Emergency story (accident, arrest, hospital)", weight: 2 },
  new_number: { label: "New number or \"lost my phone\"", weight: 2 },
  secrecy: { label: "Secrecy (\"don't tell Mom\")", weight: 2 },
  story_changes: { label: "Story contradicts itself about who they are or why they need money", weight: 2 },
  family_pass: { label: "Passes the family question", weight: -5 },
  callback_accepted: { label: "Accepts a callback on the saved number", weight: -4 },
  details_check_out: { label: "Gives details that check out", weight: -2 },
};
export const SIGN_IDS = Object.keys(SIGNS);

export function levelFor(score: number): Level {
  return score >= 8 ? "High" : score >= 4 ? "Medium" : "Low";
}

/**
 * Score = sum of weights of active signs (each id counts once).
 * Locks as "High risk: confirmed" when High + a failed check + a money or code request,
 * all confirmed by the analyst. Once locked it stays locked for the call.
 */
export function scoreRisk(signs: Sign[], wasLocked: boolean): RiskLevel {
  const active = signs.filter((s) => s.status !== "removed");
  const score = active.reduce((a, s) => a + s.weight, 0);
  const level = levelFor(score);
  const confirmedIds = new Set(active.filter((s) => s.status === "confirmed").map((s) => s.id));
  const confirmedScore = active.filter((s) => s.status === "confirmed").reduce((a, s) => a + s.weight, 0);
  const lockRule =
    levelFor(confirmedScore) === "High" &&
    (confirmedIds.has("family_fail") || confirmedIds.has("callback_refused")) &&
    (confirmedIds.has("money") || confirmedIds.has("code"));
  return {
    level: wasLocked ? "High" : level,
    score,
    locked: wasLocked || lockRule,
    provisional: levelFor(confirmedScore) !== level,
  };
}

/** Fast-lane directions: ready instantly, replaced by Neon's tailored ones when they arrive. */
export interface StockDirection {
  key: string;
  category: DirectionCategory;
  label: string;
  say: string;
}
export const STOCK: StockDirection[] = [
  { key: "who", category: "probe_details", label: "Ask who's calling", say: "Who am I speaking with, and what is this about?" },
  { key: "need", category: "probe_details", label: "Ask what they need", say: "What do you need from Alex right now?" },
  { key: "family", category: "verify_identity", label: "Ask something only family knows", say: "Quick check Alex asked me to do: can you tell me something only you and Alex would know?" },
  { key: "callback", category: "offer_callback", label: "Offer a callback", say: "Alex can call you back on the number Alex already has for you. Would that work?" },
  { key: "slow", category: "slow_down", label: "Slow it down", say: "Alex wants to help. Let's take this one step at a time." },
  { key: "decline", category: "decline", label: "Decline", say: "I can't share codes or send money. Alex will decide." },
];

export const INTRO = "Hi, I'm Alex's AI assistant. Alex is listening. Who's calling, and how can I help?";

/**
 * Last line of defence for anything the agent will say aloud. Returns a reason to block, or null.
 * The agent never commits, approves, pays or shares codes, and never reads private notes.
 */
export function guardSay(text: string): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > 240) return "too long";
  if (/\b\d{4,8}\b/.test(t.replace(/\$[\d,]+/g, ""))) return "contains a number that could be a code";
  if (/\b(approve[sd]?|authori[sz]e[sd]?|go ahead|you have (my|alex'?s) (ok|permission)|deal)\b/i.test(t)) return "sounds like an approval";
  if (/\b(i|we|alex)('ll| will| can| am going to)\s+(send|pay|transfer|wire|venmo|zelle)\b/i.test(t)) return "commits to a payment";
  if (/\b(the code is|password is|pin is|here('s| is) the code)\b/i.test(t)) return "shares a code";
  if (/\b(private|note[sd]?|risk score|warning sign|scam)\b/i.test(t)) return "leaks private analysis";
  if (/\bour\b|\bmy (childhood|family|pet|dog|cat|mom|dad|mother|father|grandma|grandmother|sister|brother|cousin|holiday)\b|\bbefore i (send|pay)\b|\bwhen we\b|\bwe (all |both )?(lived|were|grew|visited|went|did|had|saw|used to|met|talked|spoke|always|shared|played|stayed|called|took|ate)\b|\b(with|between) us\b/i.test(t))
    return "speaks as Alex or family instead of the assistant";
  if (/\b(end|hang up|disconnect)\b[^.]{0,20}\b(this|the) call\b/i.test(t)) return "ends the call (only Alex can)";
  return null;
}
