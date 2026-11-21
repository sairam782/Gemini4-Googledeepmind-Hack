/**
 * Instant word-matching flags (milliseconds). Everything it finds is provisional until
 * Hydrogen or Neon confirms it. Keep patterns conservative: false alarms here are visible.
 */
const RULES: { id: string; re: RegExp }[] = [
  // A dollar amount alone isn't a request ("a $64 purchase"); it needs an ask around it.
  { id: "money", re: /\b(need|send|pay|wire|transfer|lend|give me|venmo|zelle)\b[^.?!]{0,40}(\$\s?\d|\b(hundred|thousand|grand)\b|\bdollars\b)|\$\s?\d[\d,]*\b(?![^.?!]{0,20}\b(estimate|quote|invoice|purchase|charge)\b)[^.?!]{0,30}\b(for|by|now)\b|\bsend (me |it |the )?(the )?money\b|\bjust send it\b/i },
  { id: "third_party_pay", re: /\b(venmo|zelle|cash ?app|gift ?cards?|bitcoin|crypto|western union|my friend'?s account|to my friend|this account)\b/i },
  { id: "code", re: /\b(?<!(zip|area|postal|promo|discount|dress|country|bar|qr) )(code|password|pin|verification number|one[- ]time)\b/i },
  { id: "deadline", re: /\b(right now|no time|hurry|minutes?|immediately|asap|urgent|before it'?s too late|by tonight)\b/i },
  { id: "emergency", re: /\b(accident|hospital|arrested|jail|police|stuck|stranded|hurt|emergency)\b/i },
  { id: "new_number", re: /\b(lost my phone|phone (broke|died|is broken)|new number|friend'?s phone|on a friend'?s|calling from a friend)\b/i },
  { id: "secrecy", re: /\b(don'?t tell|keep (this|it) (between us|secret)|nobody can know)\b/i },
  // Preserve the learned coercion phrases under the shared authority-threat sign.
  { id: "authority_threat", re: /\b(account|card)s? (will be|gets?|is being) (frozen|locked|suspended|closed)\b|\b(warrant|arrest(ed)?|lawsuit|legal action)\b[^.?!]{0,30}\b(you|your)\b|\b(warrant|lawsuit|legal action|sue (you|alex)|deport\w*|(you|alex)('ll| will)? (be|get) arrested|arrest (you|alex)|police (will|are) (come|coming|on (their|the) way)|(account|card)s? (will |is going to |gets? )?(be )?(frozen|suspended|locked|closed)|(freeze|suspend|lock|close) (your|alex'?s|the) (account|card))\b/i },
  { id: "callback_refused", re: /\b(don'?t (call|hang up)|if you hang up|lose your place|can'?t call (me )?back|no,? don'?t call)\b/i },
];

// Phrases that mention a sign word but are reassurance, not a request ("we will never ask for your PIN").
const NEGATED = /\b(never|won'?t|will not|do not need|no) (ask|need|require)?\s*(for )?(your )?(pin|code|password|payment)\b|\bno payment\b/i;

export function flagTurn(text: string): string[] {
  const hits = RULES.filter((r) => r.re.test(text)).map((r) => r.id);
  // "We never ask for your PIN" is reassurance, unless the same turn also asks for one.
  const asks = /\b(read|give|tell|send)\b[^.?!]{0,20}\b(me|us)\b[^.?!]{0,20}\b(code|pin|password)\b|\bread (it|the code) (back|to me)\b/i.test(text);
  if (NEGATED.test(text) && !asks) return hits.filter((id) => id !== "code" && id !== "money");
  return hits;
}
