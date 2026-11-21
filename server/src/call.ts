import type { CallReview, DeskClientMsg, DeskServerMsg, Floor, FollowUpAction, Lane, Level, Speaker } from "../../shared/brain.ts";
import { CallBrain } from "./brain/orchestrator.ts";
import { INTRO, STOCK, guardSay } from "./brain/catalog.ts";
import { renderSpeech, ttsEnabled } from "./tts.ts";
import { reviewCall } from "./brain/review.ts";
import { executeFollowUp, proposeFollowUps } from "./brain/followup.ts";
import type { CallContext } from "./brain/lanes.ts";
import { saveCall } from "./store.ts";
import { buildRecord } from "./learn/record.ts";
import { playbookForNextCall, reviewAndLearn } from "./learn/pipeline.ts";
import type { CallRecord, Label } from "./learn/types.ts";

/** LEARN=0 turns the review phase off (no playbook loaded, no critic after hang-up). */
const learningOn = () => process.env.LEARN !== "0";

export interface CallMeta {
  source: CallRecord["source"];
  scenarioId?: string;
  personaId?: string;
  label?: Label;
  labelSource?: CallRecord["labelSource"];
  /** false: don't run the critic automatically after the review (eval rounds call it themselves). */
  autoLearn?: boolean;
}

type ControlMsg = Extract<DeskClientMsg, { actionId: string; revision: number }>;
type Listener = (m: DeskServerMsg) => void;

/** Where the agent's voice goes: the desk's speakers, or the phone line (Twilio). */
export interface AgentVoice {
  speak(turnId: string, text: string): void; // must call call.agentDone(turnId) when playback ends
  cut(turnId: string): void; // stop now
  prerender?(texts: string[]): void;
}

/**
 * Auto-speak: if Alex hasn't tapped a direction this long after the caller's line, the agent says the
 * best one itself. 4 s: Flash-Lite cards land at ~1.3 s (p90 ~2.4 s) and their speech is pre-rendered by
 * ~3-4 s, which still leaves Alex 2-3 s to read and override. On a phone the caller also hears ~1 s of
 * end-of-speech detection, so the gap is ~5 s, about a thoughtful pause. If no tailored card is up yet,
 * wait up to AUTO_WAIT_MS more for one before falling back to a stock card. AUTO_SPEAK_MS=0 turns it off.
 */
const AUTO_SPEAK_MS = Number(process.env.AUTO_SPEAK_MS ?? 4000);
const AUTO_WAIT_MS = 2000;

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
  readonly from: string;
  readonly startedAt = Date.now();
  endedAt: number | null = null;
  floor: Floor = "alex";
  revision = 1;
  private speaking: string | null = null;
  private playing: string | null = null; // the agent turn whose audio is actually out on the line
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  autoSpeakMs = AUTO_SPEAK_MS;
  private autoDeadline = 0;
  /** Desk live mode: caller text arrives before its audio is played, so the auto clock starts at callerAudioDone. */
  waitForCallerAudio = false;
  private lastAgentEnd = 0;
  private introduced = false;
  private consumed = new Set<string>();
  private listeners = new Set<Listener>();
  private history: DeskServerMsg[] = [];
  private lanes: { lane: Lane; turnId: string; ms: number; ok: boolean; note?: string }[] = [];
  private guardBlocks = 0;
  private followUpState = new Map<string, "pending" | "approved" | "dismissed">();
  review: CallReview | null = null;
  followUps: FollowUpAction[] = [];
  voice: AgentVoice | null = null;
  lineInfo: () => { nextLine: number; totalLines: number } = () => ({ nextLine: 0, totalLines: 0 });

  readonly ctx: CallContext;
  private meta: CallMeta;
  private learning: Promise<void> | null = null;
  private loadingPlaybook?: Promise<void>;

  constructor(
    readonly id: string,
    ctx: CallContext,
    private expected?: { level: Level; verdict: string },
    meta: CallMeta = { source: "phone" },
  ) {
    this.from = ctx.from;
    // Each call starts from the current playbook, unless the caller (an eval run) chose one.
    this.ctx = { ...ctx };
    const playbook = ctx.playbook ?? (learningOn() ? playbookForNextCall() : undefined);
    if (playbook instanceof Promise) {
      this.loadingPlaybook = playbook
        .then((loaded) => { this.ctx.playbook = loaded; })
        .catch((error) => {
          console.error("[learn] could not load playbook:", (error as Error).message);
          this.emit({ type: "error", message: "Could not load the playbook. This call will use default rules." });
        })
        .finally(() => { this.loadingPlaybook = undefined; });
    } else {
      this.ctx.playbook = playbook;
    }
    this.meta = { ...meta, label: meta.label ?? (expected ? (expected.level === "High" ? "scam" : "legit") : "unknown"), labelSource: meta.labelSource ?? (expected ? "scenario" : "none") };
    this.brain = new CallBrain(this.ctx, (m) => this.emit(m), () => this.revision);
    this.brain.holdUpgrades = () => this.floor === "agent";
    // Warm the speech cache with every line the agent can say before any model has run.
    if (ttsEnabled()) [INTRO, ...STOCK.map((d) => d.say)].forEach((t) => void renderSpeech(t).catch(() => {}));
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
    // The board changed under a running countdown: tell the app which card will be said now.
    if (m.type === "directions" && this.autoTimer && m.directions.length) {
      this.emit({ type: "agent.autoPick", directionId: this.brain.bestDirection()?.id ?? null, inMs: Math.max(0, this.autoDeadline - Date.now()), revision: this.revision });
    }
  }

  state() {
    this.emit({ type: "state", floor: this.floor, revision: this.revision, ...this.lineInfo() });
  }

  /** Every event so far (the call's log). */
  events(): readonly DeskServerMsg[] {
    return this.history;
  }

  get ended() {
    return this.floor === "ended";
  }

  // Preserve the order of input while Supabase loads the call's playbook.
  private deferUntilPlaybook(action: () => void): boolean {
    if (!this.loadingPlaybook) return false;
    void this.loadingPlaybook.then(action).catch((error) => console.error("[call]", error));
    return true;
  }

  // ---------------------------------------------------------------- inputs

  caller(text: string) {
    if (this.deferUntilPlaybook(() => this.caller(text))) return;
    if (this.ended || !text.trim()) return;
    this.brain.addTurn("caller", text.trim().slice(0, 500));
    if (!this.waitForCallerAudio) this.scheduleAuto();
  }

  callerAudioDone(turnId: string) {
    if (this.waitForCallerAudio && turnId === this.brain.lastCallerTurnId()) this.scheduleAuto();
  }

  /** Alex speaking. From the desk it's refused while the agent has the floor; on a phone, Alex's voice wins. */
  alex(text: string, from: "desk" | "phone" = "desk") {
    if (this.deferUntilPlaybook(() => this.alex(text, from))) return;
    if (this.ended || !text.trim()) return;
    if (this.floor === "agent") {
      if (from === "desk") return this.emit({ type: "error", message: "Alex's mic is muted while the agent has the floor. Take back first." });
      this.takeBack(this.speaking ?? undefined);
    }
    this.brain.addTurn("alex", text.trim().slice(0, 500));
  }

  interim(speaker: Speaker, text: string) {
    this.emit({ type: "caption.interim", speaker, text });
    // Barge-in: the caller talks over the agent. Stop the agent so it doesn't talk across them;
    // the floor stays with the agent and Alex picks the next line as usual.
    // Only audio that is actually playing can be talked over; a line still rendering is left alone.
    if (speaker === "caller" && this.speaking && this.playing === this.speaking && text.split(/\s+/).length >= 3) {
      const t = this.speaking;
      this.voice?.cut(t);
      this.brain.cutTurn(t);
      this.speaking = null;
      this.playing = null;
      this.lastAgentEnd = Date.now();
      this.emit({ type: "agent.cut", turnId: t });
    }
  }

  agentDone(turnId: string) {
    if (this.speaking === turnId) {
      this.speaking = null;
      this.playing = null;
      this.lastAgentEnd = Date.now();
      this.emit({ type: "agent.done", turnId });
    }
  }

  /** The voice started sending this turn's audio to the line. */
  agentPlaying(turnId: string) {
    if (this.speaking === turnId) this.playing = turnId;
  }

  /** True while the agent is talking, or just stopped: audio heard on Alex's track then is the agent's echo. */
  agentAudible(graceMs = 800) {
    return this.speaking !== null || Date.now() - this.lastAgentEnd < graceMs;
  }

  get agentSpeaking() {
    return this.speaking;
  }

  // ---------------------------------------------------------------- Alex's taps

  control(m: ControlMsg) {
    if (this.deferUntilPlaybook(() => this.control(m))) return;
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
      if (this.brain.lastCallerTurnId()) this.scheduleAuto();
    } else if (m.type === "control.takeback") {
      this.takeBack(m.cutTurnId);
      this.accept(m.actionId);
    } else if (m.type === "direction.pick") {
      if (this.floor !== "agent") return reject("not delegated: tap Agent take over first");
      if (this.speaking) return reject("busy: the agent is still speaking");
      const d = this.brain.findDirection(m.directionId);
      if (!d) return reject("stale");
      this.cancelAuto();
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
    this.cancelAuto();
    if (this.speaking && (!cutTurnId || cutTurnId === this.speaking)) {
      this.voice?.cut(this.speaking);
      this.brain.cutTurn(this.speaking);
      this.emit({ type: "agent.cut", turnId: this.speaking });
    }
    this.speaking = null;
    this.playing = null;
    if (this.floor === "agent") this.floor = "alex";
    this.revision++;
    this.brain.reissue();
    this.state();
  }

  // ---------------------------------------------------------------- auto-speak

  private scheduleAuto() {
    this.cancelAuto(false);
    const forTurn = this.brain.lastCallerTurnId();
    if (!this.autoSpeakMs || this.floor !== "agent" || !forTurn) return;
    const hardStop = Date.now() + this.autoSpeakMs + AUTO_WAIT_MS;
    this.autoDeadline = Date.now() + this.autoSpeakMs;
    this.emit({ type: "agent.autoPick", directionId: this.brain.bestDirection()?.id ?? null, inMs: this.autoSpeakMs, revision: this.revision });
    this.autoTimer = setTimeout(() => this.fireAuto(forTurn, hardStop), this.autoSpeakMs);
  }

  private cancelAuto(announce = true) {
    if (!this.autoTimer) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    if (announce) this.emit({ type: "agent.autoPick", directionId: null, inMs: 0, revision: this.revision });
  }

  private fireAuto(forTurn: string, hardStop: number) {
    this.autoTimer = null;
    if (this.ended || this.floor !== "agent" || this.brain.lastCallerTurnId() !== forTurn) return;
    const retry = () => (this.autoTimer = setTimeout(() => this.fireAuto(forTurn, hardStop), 250));
    // Let the agent finish its current line, and give Flash-Lite a moment if only stock cards are up.
    if (this.speaking || (!this.brain.hasTailoredBoard() && Date.now() < hardStop)) return retry();
    const d = this.brain.bestDirection(true);
    if (!d) return Date.now() < hardStop + 3000 ? retry() : undefined;
    this.revision++;
    this.brain.picked(d);
    this.agentSay(d.say, d.id, true);
    this.state();
  }

  private agentSay(text: string, directionId: string | null, auto = false) {
    const blocked = guardSay(text);
    if (blocked) {
      this.guardBlocks++;
      return this.emit({ type: "error", message: `guard blocked agent line (${blocked})` });
    }
    const turn = this.brain.addTurn("agent", text);
    this.speaking = turn.turnId;
    this.emit({ type: "agent.say", turnId: turn.turnId, text, revision: this.revision, directionId, ...(auto ? { auto } : {}) });
    this.voice?.speak(turn.turnId, text);
  }

  private accept(actionId: string) {
    this.emit({ type: "action.accepted", actionId, revision: this.revision });
  }

  // ---------------------------------------------------------------- post-call follow-ups

  approveFollowUp(actionId: string, followupId: string) {
    if (this.consumed.has(actionId)) {
      this.emit({ type: "action.rejected", actionId, revision: this.revision, reason: "duplicate" });
      this.emit({ type: "followup.result", followupId, ok: false, detail: "duplicate action" });
      return;
    }
    const action = this.followUps.find((a) => a.id === followupId);
    const state = this.followUpState.get(followupId);
    if (!action || !state) {
      this.emit({ type: "action.rejected", actionId, revision: this.revision, reason: "unknown follow-up" });
      this.emit({ type: "followup.result", followupId, ok: false, detail: "unknown follow-up" });
      return;
    }
    if (state !== "pending") {
      const detail = state === "approved" ? "already executed" : "already dismissed";
      this.emit({ type: "action.rejected", actionId, revision: this.revision, reason: detail });
      this.emit({ type: "followup.result", followupId, ok: false, detail });
      return;
    }
    this.consumed.add(actionId);
    this.followUpState.set(followupId, "approved");
    this.accept(actionId);
    const res = executeFollowUp(action);
    this.emit({ type: "followup.result", followupId, ok: res.ok, detail: res.detail });
  }

  dismissFollowUp(followupId: string) {
    const state = this.followUpState.get(followupId);
    if (!state) {
      this.emit({ type: "followup.result", followupId, ok: false, detail: "unknown follow-up" });
      return;
    }
    if (state !== "pending") {
      const detail = state === "approved" ? "already executed" : "already dismissed";
      this.emit({ type: "followup.result", followupId, ok: false, detail });
      return;
    }
    this.followUpState.set(followupId, "dismissed");
    this.emit({ type: "followup.result", followupId, ok: true, detail: "dismissed" });
  }

  // ---------------------------------------------------------------- hang-up and review

  end(reason: string) {
    if (this.deferUntilPlaybook(() => this.end(reason))) return;
    if (this.ended) return;
    this.cancelAuto(false);
    if (this.speaking) {
      this.voice?.cut(this.speaking);
      this.brain.cutTurn(this.speaking);
      this.emit({ type: "agent.cut", turnId: this.speaking });
      this.speaking = null;
    }
    this.playing = null;
    this.floor = "ended";
    this.endedAt = Date.now();
    this.revision++;
    this.brain.ended = true;
    this.emit({ type: "call.ended", reason });
    this.state();
    void this.runReview().catch((e) => {
      console.error("[review] failed:", e);
      this.emit({ type: "error", message: `review failed: ${(e as Error).message}` });
    });
  }

  private async runReview() {
    if (!this.brain.snapshot().turns.some((t) => t.speaker === "caller")) return;
    await this.brain.finalize();
    const snap = this.brain.snapshot();
    const review = await reviewCall({ callId: this.id, ...snap, lanes: this.lanes, guardBlocks: this.guardBlocks, expected: this.expected });
    this.review = review;
    try {
      saveCall({ callId: this.id, from: this.from, startedAt: this.startedAt, endedAt: this.endedAt ?? Date.now(), review });
    } catch (e) {
      this.emit({ type: "error", message: `could not save call history: ${(e as Error).message}` });
    }
    this.emit({ type: "lane.result", lane: "review", model: review.model, turnId: snap.turns.at(-1)!.turnId, ms: review.ms, ok: !review.summary.startsWith("Review model failed"), note: `${review.verdict}; ${review.evals.filter((e) => e.pass).length}/${review.evals.length} evals pass` });
    this.emit({ type: "call.review", review });
    const learning = learningOn() && this.meta.autoLearn !== false ? this.learn() : undefined;
    const actions = await proposeFollowUps({
      callId: this.id,
      from: this.ctx.from,
      inContacts: this.ctx.inContacts,
      review,
      turns: snap.turns,
      notes: snap.notes,
    });
    this.followUps = actions;
    actions.forEach((a) => this.followUpState.set(a.id, "pending"));
    this.emit({ type: "followup.proposed", actions });
    setTimeout(() => calls.delete(this.id), 30 * 60_000); // keep reviews readable for a while
    await learning;
  }

  /** Review phase: judge + critic + playbook update. Resolves when done (eval scripts await it). */
  learn(): Promise<void> {
    const job = async () => {
      const record = this.record();
      const out = await reviewAndLearn(record);
      this.emit({ type: "critic.report", report: out.critic, metrics: out.metrics, label: record.label });
      if (out.update) {
        this.emit({
          type: "playbook.updated",
          update: out.update,
          version: out.playbook.version,
          active: out.playbook.lessons.filter((l) => l.status === "active").map(({ id, when, do: d, action, seen }) => ({ id, when, do: d, action, seen })),
        });
      }
    };
    // One review at a time per call; a label that arrives mid-review re-runs it afterwards.
    this.learning = (this.learning ?? Promise.resolve()).then(job, job).catch((e) => {
      console.error("[learn] failed:", e);
      this.emit({ type: "error", message: `critic failed: ${(e as Error).message}` });
    });
    return this.learning;
  }

  /** The call as the review phase stores it. */
  record(): CallRecord {
    return buildRecord(this.history, {
      callId: this.id,
      source: this.meta.source,
      scenarioId: this.meta.scenarioId,
      personaId: this.meta.personaId,
      from: this.ctx.from,
      inContacts: this.ctx.inContacts,
      label: this.meta.label ?? "unknown",
      labelSource: this.meta.labelSource ?? "none",
      playbookVersion: this.ctx.playbook?.version ?? 0,
      guardBlocks: this.guardBlocks,
    });
  }

  /** Alex answered "Was this a scam?" after hang-up. The critic re-runs with the real label. */
  setLabel(label: Label) {
    if (!this.ended) return this.emit({ type: "error", message: "label the call after it ends" });
    this.meta = { ...this.meta, label, labelSource: "alex" };
    if (learningOn() && this.review) void this.learn();
  }
}
