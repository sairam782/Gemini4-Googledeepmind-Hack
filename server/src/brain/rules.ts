/**
 * Instant word-matching flags (milliseconds). Everything it finds is provisional until
 * Hydrogen or Neon confirms it. Keep patterns conservative: false alarms here are visible.
 */
const RULES: { id: string; re: RegExp }[] = [
  // A dollar amount alone isn't a request ("a $64 purchase"); it needs an ask around it.
  { id: "money", re: /\b(need|send|pay|wire|transfer|lend|give me|venmo|zelle)\b[^.?!]{0,40}\$\s?\d|\$\s?\d[\d,]*\b[^.?!]{0,30}\b(for|by|now)\b|\bsend (me |it |the )?(the )?money\b|\bjust send it\b/i },
  { id: "third_party_pay", re: /\b(venmo|zelle|cash ?app|gift ?cards?|bitcoin|crypto|western union|my friend'?s account|to my friend|this account)\b/i },
  { id: "code", re: /\b(code|password|pin|verification number|one[- ]time)\b/i },
  { id: "deadline", re: /\b(right now|no time|hurry|minutes?|immediately|asap|urgent|before it'?s too late|by tonight)\b/i },
  { id: "emergency", re: /\b(accident|hospital|arrested|jail|police|stuck|stranded|hurt|emergency)\b/i },
  { id: "new_number", re: /\b(lost my phone|phone (broke|died|is broken)|new number|friend'?s phone|on a friend'?s|calling from a friend)\b/i },
  { id: "secrecy", re: /\b(don'?t tell|keep (this|it) (between us|secret)|nobody can know)\b/i },
  { id: "callback_refused", re: /\b(don'?t (call|hang up)|can'?t call (me )?back|no,? don'?t call)\b/i },
];

// Phrases that mention a sign word but are reassurance, not a request ("we will never ask for your PIN").
const NEGATED = /\b(never|won'?t|will not|do not need|no) (ask|need|require)?\s*(for )?(your )?(pin|code|password|payment)\b|\bno payment\b/i;

export function flagTurn(text: string): string[] {
  const hits = RULES.filter((r) => r.re.test(text)).map((r) => r.id);
  if (NEGATED.test(text)) return hits.filter((id) => id !== "code" && id !== "money");
  return hits;
}
