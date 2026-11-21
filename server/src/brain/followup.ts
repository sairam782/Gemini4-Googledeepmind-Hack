import { randomUUID } from "node:crypto";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import type { CallReview, FollowUpAction, FollowUpReportTarget, Turn } from "../../../shared/brain.ts";
import { blockNumber } from "../blocklist.ts";
import { thinkingFor } from "./llm.ts";

// Implemented with @google/genai function calling rather than Gemini Managed Agents:
// Managed Agents (Interactions API, remote Linux sandbox) requires @google/genai v2.3+
// and does not fit local human-in-the-loop action proposals.
// Docs: https://ai.google.dev/gemini-api/docs/function-calling
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export const FOLLOWUP_MODEL = process.env.FOLLOWUP_MODEL || "gemini-4-neon";

const REPORT_TARGETS: readonly FollowUpReportTarget[] = ["bank", "ftc", "police", "other"];

const TOOLS: FunctionDeclaration[] = [
  {
    name: "draft_text_message",
    description:
      'Propose a draft text message to a saved/trusted contact (e.g. "Maya (saved number)"). Never address a scammer or unknown caller. Only proposes a draft; never sends.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'Saved contact recipient, e.g. "Maya (saved number)"' },
        body: { type: Type.STRING, description: "Short plain-text message. Never include 4-8 digit codes, PINs, or payment promises." },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "draft_report",
    description:
      "Propose a draft fraud or scam report to the bank, FTC, police, or another organization. Only proposes a draft; never submits.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, enum: [...REPORT_TARGETS], description: "Recipient: bank, ftc, police, or other" },
        body: { type: Type.STRING, description: "Concise factual report of what happened. Never include verification codes, PINs, or payment promises." },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "block_number",
    description: "Propose adding an unwanted or suspected scam caller's phone number to Alex's blocklist.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        number: { type: Type.STRING, description: "The caller's phone number to block" },
      },
      required: ["number"],
    },
  },
  {
    name: "set_reminder",
    description:
      "Propose a personal reminder for Alex (e.g. pick up a prescription, call the real bank using the number on the card, check with family on their saved number).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "What Alex should remember. Never tell Alex to send money, share a code, or call a scammer back." },
        when: { type: Type.STRING, description: 'When to remind Alex, e.g. "Today in 1 hour", "Tomorrow 9 AM", "Tuesday 9 AM"' },
      },
      required: ["text", "when"],
    },
  },
];

export interface FollowUpInput {
  callId: string;
  from: string;
  inContacts: boolean;
  review: CallReview;
  turns: Turn[];
  notes: Record<string, string>;
}

export interface StoredReminder {
  id: string;
  text: string;
  when: string;
  createdAt: number;
}

const reminders: StoredReminder[] = [];

export function listReminders(): StoredReminder[] {
  return [...reminders];
}

function digitsOnly(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/** Remove formatted occurrences of a known caller phone number (used only for fraud reports). */
function stripCallerNumber(text: string, callerFrom: string): string {
  const d = digitsOnly(callerFrom);
  if (d.length < 7) return text;
  const escapedExact = callerFrom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text.replace(new RegExp(escapedExact, "g"), "[caller-number]");
  if (d.length === 10) {
    const loose = new RegExp(`(?:\\+?1[-.\\s]?)?\\(?${d.slice(0, 3)}\\)?[-.\\s]?${d.slice(3, 6)}[-.\\s]?${d.slice(6)}`, "g");
    out = out.replace(loose, "[caller-number]");
  }
  return out;
}

/**
 * Guard on every proposed follow-up body/text (mirroring guardSay's code and payment checks,
 * while allowing legitimate post-call terms like "scam" in a fraud report).
 */
export function guardFollowUpText(text: string, opts: { allowCallerNumber?: string; blockCallerCallback?: string } = {}): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > 600) return "too long";

  // Strip dollar amounts (and, for reports only, the caller's own phone number) before scanning for codes.
  let scan = t.replace(/\$[\d,]+(?:\.\d{1,2})?/g, "");
  if (opts.allowCallerNumber) scan = stripCallerNumber(scan, opts.allowCallerNumber);

  if (/\b\d{4,8}\b/.test(scan)) return "contains a 4-8 digit number that could be a code";
  if (/\b(the code is|password is|pin is|here('s| is) the code|share (the |your )?(code|pin|password)|read (back|out) (the )?(code|pin))\b/i.test(t)) {
    return "shares or requests a verification code";
  }
  if (/\b(i|we|alex)('ll| will| can| am going to| should)\s+(send|pay|transfer|wire|venmo|zelle)\b/i.test(t)) {
    return "commits to a payment";
  }
  if (/\b(send|wire|transfer|venmo|zelle)\s+(the\s+)?(money|payment|funds|\$?\d[\d,]*|gift ?cards?|crypto|bitcoin)\b/i.test(t)) {
    return "proposes sending money";
  }
  if (/\b(pay\s+(them|him|her|the caller|\$?\d[\d,]*)|buy\s+gift ?cards?)\b/i.test(t)) {
    return "proposes a payment";
  }
  if (opts.blockCallerCallback) {
    const callerDigits = digitsOnly(opts.blockCallerCallback);
    if (callerDigits.length >= 7 && digitsOnly(t).includes(callerDigits)) {
      return "references calling or texting the scammer's number";
    }
    if (/\b(call|text|ring)\s+(the\s+)?(scammer|caller|them)\s+back\b/i.test(t)) {
      return "suggests calling the scammer back";
    }
  }
  return null;
}

function reportTitle(to: FollowUpReportTarget): string {
  switch (to) {
    case "bank": return "Draft bank fraud report";
    case "ftc": return "Draft FTC scam report";
    case "police": return "Draft police report";
    case "other": return "Draft incident report";
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Validate and convert one model tool call into a guarded FollowUpAction, or null if rejected. */
function validateCall(
  name: string,
  args: Record<string, unknown>,
  input: FollowUpInput,
  seen: Set<string>,
): FollowUpAction | null {
  const isSuspicious = input.review.verdict === "scam" || input.review.finalLevel === "High";
  const id = `fu-${randomUUID().slice(0, 8)}`;

  if (name === "draft_text_message") {
    const to = str(args.to).slice(0, 80);
    const body = str(args.body);
    if (!to || !body) return null;
    // Never draft a text to the scammer or an unknown caller number.
    const callerDigits = digitsOnly(input.from);
    if (isSuspicious && callerDigits.length >= 7 && digitsOnly(to).includes(callerDigits)) return null;
    if (/\b(scammer|fraud department|unknown caller|the caller)\b/i.test(to)) return null;
    if (guardFollowUpText(body, { blockCallerCallback: isSuspicious ? input.from : undefined })) return null;
    const key = `text:${to.toLowerCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { id, kind: "draft_text_message", title: `Draft text to ${to}`, details: body, payload: { to, body } };
  }

  if (name === "draft_report") {
    const rawTo = str(args.to).toLowerCase() as FollowUpReportTarget;
    const body = str(args.body);
    if (!REPORT_TARGETS.includes(rawTo) || !body) return null;
    if (guardFollowUpText(body, { allowCallerNumber: input.from })) return null;
    const key = `report:${rawTo}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { id, kind: "draft_report", title: reportTitle(rawTo), details: body, payload: { to: rawTo, body } };
  }

  if (name === "block_number") {
    const number = str(args.number) || input.from;
    const d = digitsOnly(number);
    if (d.length < 7) return null;
    // Don't propose blocking an arbitrary unrelated number that wasn't the caller.
    const callerDigits = digitsOnly(input.from);
    if (callerDigits.length >= 7 && d !== callerDigits) return null;
    const key = `block:${d}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      id,
      kind: "block_number",
      title: `Block ${number}`,
      details: `Add ${number} to your blocklist`,
      payload: { number },
    };
  }

  if (name === "set_reminder") {
    const text = str(args.text).slice(0, 240);
    const when = str(args.when).slice(0, 80);
    if (!text || !when) return null;
    if (guardFollowUpText(text, { blockCallerCallback: isSuspicious ? input.from : undefined })) return null;
    const key = `rem:${text.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { id, kind: "set_reminder", title: `Reminder: ${when}`, details: `${text} (${when})`, payload: { text, when } };
  }

  return null;
}

/**
 * Turns Carbon's post-call review and follow-up suggestions into up to 4 concrete, guarded
 * tool proposals for Alex to approve one by one. Never throws; returns [] on failure.
 */
export async function proposeFollowUps(input: FollowUpInput): Promise<FollowUpAction[]> {
  if (!ai) return [];
  const model = process.env.FOLLOWUP_MODEL || FOLLOWUP_MODEL;
  const thinking = thinkingFor("FOLLOWUP_THINKING", "low");

  const transcript = input.turns
    .map((t) => `${t.turnId} ${t.speaker === "agent" ? "assistant" : t.speaker}: ${t.text}`)
    .join("\n");
  const suggested = input.review.followUps.map((f, i) => `${i + 1}. ${f.action} (${f.why})`).join("\n") || "none";

  const prompt = `A phone call to Alex just ended and was reviewed. Turn the review's suggested next steps into concrete follow-up proposals by calling the provided tools (up to 4 tool calls total).

Caller number: ${input.from} (${input.inContacts ? "in Alex's contacts" : "NOT in Alex's contacts"})
Verdict: ${input.review.verdict} (risk: ${input.review.finalLevel}${input.review.locked ? ", locked High risk confirmed" : ""})
Summary: ${input.review.summary}
Notes: ${JSON.stringify(input.notes)}
Review's suggested follow-ups:
${suggested}

Transcript:
${transcript}

Rules:
- Only propose safe actions using the 4 tools: draft_text_message, draft_report, block_number, set_reminder.
- NEVER propose sending money, sharing or reading back codes/PINs, or calling/texting a scammer back.
- For scam calls: typically propose block_number for ${input.from}, plus draft_report (e.g. bank/ftc) and/or a draft_text_message to a saved contact (e.g. "Maya (saved number)") or a set_reminder to contact the real bank via the number on the card.
- For legitimate calls: only propose helpful reminders or drafts if warranted (do NOT block legitimate callers).
- Keep draft bodies concise, factual, and free of any 4-8 digit codes or payment promises.
- Make 1 to 4 tool calls now.`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 35_000);
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction:
          "You are ReVoice's post-call follow-up planner. Propose safe follow-up actions ONLY by invoking the declared tools. Every action is a proposal that Alex must approve before execution.",
        tools: [{ functionDeclarations: TOOLS }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
        abortSignal: abort.signal,
        ...(thinking
          ? { thinkingConfig: { thinkingLevel: thinking === "low" ? ThinkingLevel.LOW : ThinkingLevel.HIGH } }
          : {}),
      },
    });

    const calls = res.functionCalls ?? [];
    const seen = new Set<string>();
    const actions: FollowUpAction[] = [];
    for (const fc of calls) {
      if (!fc.name) continue;
      const action = validateCall(fc.name, (fc.args ?? {}) as Record<string, unknown>, input, seen);
      if (action) actions.push(action);
      if (actions.length >= 4) break;
    }
    return actions;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Execute one follow-up action ONLY after Alex explicitly approves it. */
export function executeFollowUp(action: FollowUpAction): { ok: boolean; detail: string } {
  switch (action.kind) {
    case "block_number": {
      const ok = blockNumber(action.payload.number, "approved post-call follow-up");
      return ok
        ? { ok: true, detail: `Blocked ${action.payload.number}` }
        : { ok: false, detail: "Invalid phone number" };
    }
    case "set_reminder": {
      reminders.push({
        id: action.id,
        text: action.payload.text,
        when: action.payload.when,
        createdAt: Date.now(),
      });
      return { ok: true, detail: `Reminder saved for ${action.payload.when}: ${action.payload.text}` };
    }
    case "draft_text_message":
      return { ok: true, detail: `Ready to send to ${action.payload.to}: ${action.payload.body}` };
    case "draft_report":
      return { ok: true, detail: `Ready to send (${action.payload.to} report): ${action.payload.body}` };
  }
}
