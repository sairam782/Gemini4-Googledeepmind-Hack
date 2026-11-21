// Scam checks for one call, in three layers:
//   1. Regex rules (instant), ported from the team server (server/src/brain/rules.ts).
//   2. GEMINI_FAST_MODEL (gemini-4-hydrogen) after each caller line: warning signs.
//   3. GEMINI_CHECK_MODEL (gemini-4-neon) once the story is clear, and at hang-up: the verdict.
// Models only propose; this file decides what reaches the app and never sends a sign twice.

import { GoogleGenAI } from '@google/genai';

const FAST = () => process.env.GEMINI_FAST_MODEL || 'gemini-4-hydrogen';
const CHECK = () => process.env.GEMINI_CHECK_MODEL || 'gemini-4-neon';

let ai = null;
const client = () => (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

export const SIGNS = {
  money: 'Asks for money or a payment',
  code: 'Asks for a code, password or account detail',
  third_party_pay: 'Pays someone else, gift cards, crypto or wire',
  deadline: 'Pressure to act within minutes ("right now", "no time")',
  emergency: 'Emergency story (accident, arrest, hospital)',
  new_number: 'New number or "lost my phone"',
  secrecy: 'Secrecy ("don\'t tell Mom")',
  authority_threat: 'Claims to be a bank, agency or company and threatens a freeze, fine, arrest or loss',
  callback_refused: 'Refuses a callback on the usual number',
  story_changes: 'Story contradicts itself about who they are or why they need money',
  identity_dodge: 'Won\'t say who they are or why they\'re calling',
};

const RULES = [
  { id: 'money', re: /\b(need|send|pay|wire|transfer|lend|give me|venmo|zelle)\b[^.?!]{0,40}(\$\s?\d|\b(hundred|thousand|grand)\b|\bdollars\b)|\bsend (me |it |the )?(the )?money\b|\bjust send it\b/i },
  { id: 'third_party_pay', re: /\b(venmo|zelle|cash ?app|gift ?cards?|bitcoin|crypto|western union|my friend'?s account|to my friend|this account)\b/i },
  { id: 'code', re: /\b(code|password|pin|verification number|one[- ]time)\b/i },
  { id: 'deadline', re: /\b(right now|no time|hurry|immediately|asap|urgent|before it'?s too late|by tonight)\b/i },
  { id: 'emergency', re: /\b(accident|hospital|arrested|jail|police|stuck|stranded|hurt|emergency)\b/i },
  { id: 'new_number', re: /\b(lost my phone|phone (broke|died|is broken)|new number|friend'?s phone|on a friend'?s|calling from a friend)\b/i },
  { id: 'secrecy', re: /\b(don'?t tell|keep (this|it) (between us|secret)|nobody can know)\b/i },
  { id: 'authority_threat', re: /\b(account|card)s? (will be|gets?|is being) (frozen|locked|suspended|closed)\b|\b(warrant|arrest(ed)?|lawsuit|legal action)\b[^.?!]{0,30}\b(you|your)\b/i },
  { id: 'callback_refused', re: /\b(don'?t (call|hang up)|if you hang up|can'?t call (me )?back|no,? don'?t call)\b/i },
];
const NEGATED = /\b(never|won'?t|will not|do not need|no) (ask|need|require)?\s*(for )?(your )?(pin|code|password|payment)\b|\bno payment\b/i;

function ruleHits(text) {
  const hits = RULES.filter((r) => r.re.test(text)).map((r) => r.id);
  return NEGATED.test(text) ? hits.filter((id) => id !== 'code' && id !== 'money') : hits;
}

async function json(model, prompt) {
  const r = await client().models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });
  return JSON.parse(r.text || '{}');
}

/** Guard on suggested lines: no codes or long numbers, no promises to pay, no "scam" talk. */
const safeLine = (s) => !/\d{4,}|\b(i'll|we'll|will) (pay|send|transfer)|\bscam\b/i.test(s);

const transcriptText = (turns) => turns.map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n');

/**
 * emit(event) sends app events without callId (the caller adds it):
 *   { type: 'signal', label, turn }  and  { type: 'verdict', verdict, reasons }
 */
export function createBrain(emit, log = console) {
  const turns = [];
  const flagged = new Set();
  let callerLines = 0;
  let fastBusy = false;
  let fastAgain = false;
  let verdictSent = false; // a confident verdict during the call
  let finalDone = false;

  const flag = (id, turn) => {
    if (!SIGNS[id] || flagged.has(id)) return;
    flagged.add(id);
    emit({ type: 'signal', label: SIGNS[id], turn });
  };

  async function fastLane() {
    if (fastBusy) {
      fastAgain = true;
      return;
    }
    fastBusy = true;
    try {
      const last = turns.filter((t) => t.speaker === 'caller').at(-1);
      const ids = Object.entries(SIGNS).map(([id, label]) => `${id}: ${label}`).join('\n');
      const r = await json(
        FAST(),
        `You check a phone call for scam warning signs. Only flag a sign the CALLER clearly shows.
Signs (id: meaning):
${ids}

Call so far:
${transcriptText(turns)}

Also suggest 3 different next lines the ASSISTANT could say now. Each one: one short sentence, polite, spoken English.
The assistant never shares personal details, never agrees to pay or confirm anything, never asks for codes,
and never says "scam". Good moves: ask who they are, ask for details, offer a callback on the usual number, slow things down.

Return JSON: {"signs": ["<id>", ...], "replies": [{"label": "<2-4 words>", "say": "<exact words>"}, ...]}
Sign ids from the list only; empty list if none.`,
      );
      for (const id of Array.isArray(r.signs) ? r.signs : []) flag(id, last?.turn ?? 0);
      const replies = (Array.isArray(r.replies) ? r.replies : [])
        .filter((x) => x && typeof x.label === 'string' && typeof x.say === 'string' && safeLine(x.say))
        .slice(0, 3)
        .map((x, i) => ({ id: `r${last?.turn ?? 0}-${i}`, label: x.label.slice(0, 40), say: x.say.slice(0, 200) }));
      if (replies.length) emit({ type: 'directions', directions: replies });
    } catch (e) {
      log.warn(`[brain] fast lane failed: ${e.message}`);
    } finally {
      fastBusy = false;
      if (fastAgain) {
        fastAgain = false;
        void fastLane();
      }
    }
    // Once the caller has said enough, ask for a verdict.
    if (!verdictSent && callerLines >= 3) void verdict(false);
  }

  async function verdict(final) {
    try {
      const r = await json(
        CHECK(),
        `You decide whether a screened phone call is a scam. The assistant answered for the phone's owner.
Warning signs already seen: ${[...flagged].map((id) => SIGNS[id]).join('; ') || 'none'}.

Call transcript:
${transcriptText(turns)}

${final ? 'The call has ended. Give your best verdict.' : 'Only set "clear" to true if the story is clear enough to decide.'}
Return JSON: {"verdict": "scam" | "real" | "unsure", "reasons": ["<short reason>", ...up to 3], "clear": true | false}`,
      );
      const v = ['scam', 'real', 'unsure'].includes(r.verdict) ? r.verdict : 'unsure';
      const reasons = (Array.isArray(r.reasons) ? r.reasons : []).filter((x) => typeof x === 'string').slice(0, 3);
      if (final || r.clear) {
        if (!final) verdictSent = true;
        emit({ type: 'verdict', verdict: v, reasons });
      }
    } catch (e) {
      log.warn(`[brain] verdict failed: ${e.message}`);
      if (final) emit({ type: 'verdict', verdict: 'unsure', reasons: ['The verdict check failed; review the transcript.'] });
    }
  }

  return {
    /** A finished transcript line. */
    onLine(speaker, text, turn) {
      turns.push({ speaker, text, turn });
      if (speaker !== 'caller') return;
      callerLines++;
      for (const id of ruleHits(text)) flag(id, turn);
      void fastLane();
    },
    /** Call over: one final verdict (resolves when sent). */
    async finish() {
      if (finalDone) return;
      finalDone = true;
      if (callerLines === 0) return emit({ type: 'verdict', verdict: 'unsure', reasons: ['The caller didn’t say anything.'] });
      await verdict(true);
    },
  };
}
