import type { CallReview, DeskClientMsg, DeskServerMsg, Floor, Lane, Level, Speaker } from "../../shared/brain.ts";
import { CallBrain } from "./brain/orchestrator.ts";
import { INTRO, guardSay } from "./brain/catalog.ts";
import { reviewCall } from "./brain/review.ts";
import type { CallContext } from "./brain/lanes.ts";

type ControlMsg = Extract<DeskClientMsg, { actionId: string }>;
type Listener = (m: DeskServerMsg) => void;

/** Where the agent's voice goes: the desk's speakers, or the phone line (Twilio). */
export interface AgentVoice {
  speak(turnId: string, text: string): void; // must call call.agentDone(turnId) when playback ends
  cut(turnId: string): void; // stop now
  prerender?(texts: string[]): void;
}

export const calls = new Map<string, LiveCall>();
let latest: string | null = null;
export const findCall = (id: string) => calls.get(id === "latest" && latest ? latest : id) ?? null;

/**
 * One live call: the brain plus the floor, revision and one-shot taps.
 * Inputs (script, desk typing, phone transcription) and outputs (desk socket, phone app,
 * phone line) attach to it. Every event is kept so an app that joins late catches up.
 */
export class LiveCall {
  readonly brain: CallBrain;
  floor: Floor = "alex";
  revision = 1;
  private speaking: string | null = null;
  private introduced = false;
  private consumed = new Set<string>();
  private listeners = new Set<Listener>();
  private history: DeskServerMsg[] = [];
  private lanes: { lane: Lane; turnId: string; ms: number; ok: boolean; note?: string }[] = [];
  private guardBlocks = 0;
  review: CallReview | null = null;
  voice: AgentVoice | null = null;
  lineInfo: () => { nextLine: number; totalLines: number } = () => ({ nextLine: 0, totalLines: 0 });

  constructor(
    readonly id: string,
    ctx: CallContext,
    private expected?: { level: Level; verdict: string },
  ) {
    this.brain = new CallBrain(ctx, (m) => this.emit(m), () => this.revision);
    calls.set(id, this);
    latest = id;
  }

  subscribe(fn: Listener, replay = true) {
    if (replay) this.history.forEach(fn);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(m: DeskServerMsg) {
    if (m.type !== "caption.interim") this.history.push(m);
    if (m.type === "lane.result") this.lanes.push({ lane: m.lane, turnId: m.turnId, ms: m.ms, ok: m.ok, note: m.note });
    if (m.type === "directions" && this.voice?.prerender) this.voice.prerender(m.directions.map((d) => d.say));
    this.listeners.forEach((fn) => fn(m));
  }

  state() {
    this.emit({ type: "state", floor: this.floor, revision: this.revision, ...this.lineInfo() });
  }

  get ended() {
    return this.floor === "ended";
  }

  // ---------------------------------------------------------------- inputs

  caller(text: string) {
    if (this.ended || !text.trim()) return;
    this.brain.addTurn("caller", text.trim().slice(0, 500));
  }

  /** Alex speaking. From the desk it's refused while the agent has the floor; on a phone, Alex's voice wins. */
  alex(text: string, from: "desk" | "phone" = "desk") {
    if (this.ended || !text.trim()) return;
    if (this.floor === "agent") {
      if (from === "desk") return this.emit({ type: "error", message: "Alex's mic is muted while the agent has the floor. Take back first." });
      this.takeBack(this.speaking ?? undefined);
    }
    this.brain.addTurn("alex", text.trim().slice(0, 500));
  }

  interim(speaker: Speaker, text: string) {
    this.emit({ type: "caption.interim", speaker, text });
  }

  agentDone(turnId: string) {
    if (this.speaking === turnId) this.speaking = null;
  }

  get agentSpeaking() {
    return this.speaking;
  }

  // ---------------------------------------------------------------- Alex's taps

  control(m: ControlMsg) {
    const reject = (reason: string) => this.emit({ type: "action.rejected", actionId: m.actionId, revision: m.revision, reason });
    if (this.consumed.has(m.actionId)) return reject("duplicate");
    const alwaysAllowed = m.type === "control.takeback" || m.type === "call.end";
    if (this.ended && m.type !== "call.end") return reject("call ended");
    if (!alwaysAllowed && m.revision !== this.revision) return reject("stale");
    this.consumed.add(m.actionId);

    if (m.type === "control.delegate") {
      if (this.floor !== "alex") return reject(`floor is ${this.floor}`);
      this.floor = "agent";
      this.revision++;
      this.accept(m.actionId);
      if (!this.introduced) {
        this.introduced = true;
        this.agentSay(INTRO, null);
      }
      this.brain.reissue();
    } else if (m.type === "control.takeback") {
      this.takeBack(m.cutTurnId);
      this.accept(m.actionId);
    } else if (m.type === "direction.pick") {
      if (this.floor !== "agent") return reject("not delegated: tap Agent take over first");
      if (this.speaking) return reject("busy: the agent is still speaking");
      const d = this.brain.findDirection(m.directionId);
      if (!d) return reject("stale");
      this.revision++;
      this.accept(m.actionId);
      this.brain.picked(d);
      this.agentSay(d.say, d.id);
    } else {
      this.accept(m.actionId);
      this.end("Alex ended the call");
      return;
    }
    this.state();
  }

  private takeBack(cutTurnId?: string) {
    if (this.speaking && (!cutTurnId || cutTurnId === this.speaking)) {
      this.voice?.cut(this.speaking);
      this.brain.cutTurn(this.speaking);
      this.emit({ type: "agent.cut", turnId: this.speaking });
    }
    this.speaking = null;
    if (this.floor === "agent") this.floor = "alex";
    this.revision++;
    this.brain.reissue();
    this.state();
  }

  private agentSay(text: string, directionId: string | null) {
    const blocked = guardSay(text);
    if (blocked) {
      this.guardBlocks++;
      return this.emit({ type: "error", message: `guard blocked agent line (${blocked})` });
    }
    const turn = this.brain.addTurn("agent", text);
    this.speaking = turn.turnId;
    this.emit({ type: "agent.say", turnId: turn.turnId, text, revision: this.revision, directionId });
    this.voice?.speak(turn.turnId, text);
  }

  private accept(actionId: string) {
    this.emit({ type: "action.accepted", actionId, revision: this.revision });
  }

  // ---------------------------------------------------------------- hang-up and review

  end(reason: string) {
    if (this.ended) return;
    if (this.speaking) this.voice?.cut(this.speaking);
    this.floor = "ended";
    this.revision++;
    this.brain.ended = true;
    this.emit({ type: "call.ended", reason });
    this.state();
    void this.runReview();
  }

  private async runReview() {
    const snap = this.brain.snapshot();
    if (!snap.turns.some((t) => t.speaker === "caller")) return;
    const review = await reviewCall({ callId: this.id, ...snap, lanes: this.lanes, guardBlocks: this.guardBlocks, expected: this.expected });
    this.review = review;
    this.emit({ type: "lane.result", lane: "review", model: review.model, turnId: snap.turns.at(-1)!.turnId, ms: review.ms, ok: !review.summary.startsWith("Review model failed"), note: `${review.verdict}; ${review.evals.filter((e) => e.pass).length}/${review.evals.length} evals pass` });
    this.emit({ type: "call.review", review });
    setTimeout(() => calls.delete(this.id), 30 * 60_000); // keep reviews readable for a while
  }
}
