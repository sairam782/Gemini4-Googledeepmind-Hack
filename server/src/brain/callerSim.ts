import type { DeskServerMsg, Turn } from "../../../shared/brain.ts";
import type { LiveCall } from "../call.ts";
import { PERSONAS, type Scenario } from "../scenarios.ts";
import { generateJson, thinkingFor } from "./llm.ts";

/**
 * A Gemini-played caller for demos and tests: instead of a fixed script, the caller hears what the
 * assistant (or Alex) said and answers in character. It sees only the spoken transcript, never the
 * brain's signs, notes or directions. Flash-Lite answers in ~0.5 s, so the caller never lags the call.
 */
export const CALLER_MODEL = process.env.CALLER_MODEL || "gemini-3.5-flash-lite";
const MAX_CALLER_LINES = 14;
const IDLE_NUDGE_MS = 15_000;
const REPLY_GAP_MS = 500;
const HANG_UP_MS = 3500; // goodbye, then the line drops; lets the risk lane score the last line // a breath between the agent finishing and the caller answering

export interface CallerLine {
  text: string;
  hangUp: boolean;
}

const who = (t: Turn) => (t.speaker === "caller" ? "You" : t.speaker === "alex" ? "Alex" : "Alex's AI assistant");

export async function nextCallerLine(sc: Scenario, turns: Turn[], hint = ""): Promise<CallerLine | null> {
  const persona = PERSONAS[sc.id] ?? `${sc.caller}. Opening line: "${sc.script[0]}". Stay consistent with it.`;
  const prompt = `You are role-playing the CALLER in a realistic phone call, for testing a call assistant that answers Alex's phone.

YOUR CHARACTER: ${persona}

How to talk:
- Sound like a real person on the phone: short, spoken, contractions, sometimes a filler ("um", "look", "okay").
- 1 or 2 sentences, under 30 words. React to what was JUST said to you first; don't repeat your last line word for word.
- Stay in character. Never mention AI, tests, scripts or role-play. Never read out actual digits of a code or account.
- Set "hangUp": true only when your character would end the call now (gave up, or the business is done and you said goodbye).
${hint ? `- ${hint}\n` : ""}
The call so far (you are "You"):
${turns.map((t) => `${who(t)}: ${t.text}${t.status === "cut" ? " [cut off]" : ""}`).join("\n")}

Return JSON only: {"text": "<what you say next>", "hangUp": false}`;
  const r = await generateJson<Partial<CallerLine>>(CALLER_MODEL, prompt, { timeoutMs: 8000, thinking: thinkingFor("CALLER_THINKING", undefined) });
  const text = typeof r.data?.text === "string" ? r.data.text.trim().slice(0, 300) : "";
  if (!r.ok || !text) return null;
  return { text, hangUp: !!r.data!.hangUp };
}

/**
 * Drives one LiveCall with a live caller. Replies are timed like a phone call: generation starts as soon
 * as the agent starts talking, and the answer is spoken once the agent's audio has finished.
 *  - estimatePlayback: no speakers are attached (headless replay), so assume ~0.33 s per word of agent speech.
 */
export class SimCaller {
  private gen = 0;
  private lines = 0;
  private waitingFor: string | null = null; // agent turn whose playback we wait on before answering
  private reply: CallerLine | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private stopped = false;

  constructor(private call: LiveCall, private sc: Scenario, private opts: { estimatePlayback?: boolean } = {}) {}

  start(openAfterMs = 700) {
    this.unsub = this.call.subscribe((m) => this.on(m), false);
    setTimeout(() => this.deliver({ text: this.sc.script[0], hangUp: false }), openAfterMs);
  }

  stop() {
    this.stopped = true;
    this.unsub?.();
    if (this.idle) clearTimeout(this.idle);
  }

  private on(m: DeskServerMsg) {
    if (this.stopped) return;
    switch (m.type) {
      case "agent.say":
        if (this.opts.estimatePlayback) {
          const ms = 600 + m.text.split(/\s+/).length * 330;
          setTimeout(() => this.call.agentDone(m.turnId), ms);
        }
        return this.respond(m.turnId);
      case "agent.done":
      case "agent.cut":
        if (this.waitingFor === m.turnId) {
          this.waitingFor = null;
          this.flush();
        }
        return;
      case "turn.final":
        if (m.turn.speaker === "alex") this.respond(null);
        return;
      case "call.ended":
        return this.stop();
    }
  }

  /** Someone spoke to the caller: start drafting the answer now, speak it when they're done. */
  private respond(agentTurnId: string | null, hint = "") {
    if (this.idle) clearTimeout(this.idle);
    const my = ++this.gen;
    this.waitingFor = agentTurnId;
    this.reply = null;
    const atLimit = this.lines >= MAX_CALLER_LINES - 1;
    const h = atLimit ? "This is your last line: wrap up and hang up." : hint;
    void nextCallerLine(this.sc, this.call.brain.snapshot().turns, h).then((line) => {
      if (my !== this.gen || this.stopped) return; // someone spoke again meanwhile; a newer draft is coming
      this.reply = line ?? { text: "Sorry, what was that?", hangUp: false };
      if (atLimit) this.reply.hangUp = true;
      this.flush();
    });
  }

  private flush() {
    if (!this.reply || this.waitingFor) return;
    const line = this.reply;
    const my = this.gen;
    this.reply = null;
    setTimeout(() => my === this.gen && this.deliver(line), REPLY_GAP_MS);
  }

  private deliver(line: CallerLine) {
    if (this.stopped || this.call.ended) return;
    this.lines++;
    this.call.caller(line.text);
    this.call.state();
    if (line.hangUp) {
      setTimeout(() => this.call.end("caller hung up"), HANG_UP_MS);
      return;
    }
    // Silence on the line: a real caller says "hello?" after a while.
    this.idle = setTimeout(() => this.respond(null, "Nobody has answered you for a while; react to the silence."), IDLE_NUDGE_MS);
  }
}
