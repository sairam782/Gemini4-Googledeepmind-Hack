import type {
  DeskServerMsg, Direction, DirectionCategory, Lane, Sign, SignStatus, Speaker, Turn,
} from "../../../shared/brain.ts";
import { SIGNS, STOCK, scoreRisk } from "./catalog.ts";
import { flagTurn } from "./rules.ts";
import { analyze, fastCheck, plan, type CallContext } from "./lanes.ts";

/** Runs a job with at most one in flight; calls made meanwhile collapse into one rerun. */
class SingleFlight {
  private busy = false;
  private pending = false;
  constructor(private job: () => Promise<void>, private alive: () => boolean) {}
  kick() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    void this.job().finally(() => {
      this.busy = false;
      if (this.pending && this.alive()) {
        this.pending = false;
        this.kick();
      }
    });
  }
}

/**
 * The brain for one call. Every caller turn fans out to four lanes in parallel:
 *   rules     (~1 ms)   provisional signs + stock directions, so the panel reacts at once
 *   hydrogen  (~2-4 s)  fast check of the newest turn → provisional signs
 *   planner   (~5-8 s)  Hydrogen writes the next 3 directions with exact words
 *   neon      (~12-20 s) confirms/removes signs, writes notes and the open decision
 * App code merges the results: the score and lock rule live here, not in a model,
 * and directions computed for an older caller turn are never shown.
 */
export class CallBrain {
  readonly turns: Turn[] = [];
  private signs = new Map<string, Sign>();
  private notes = new Map<string, { value: string; turnId: string }>();
  private directions: Direction[] = [];
  private directionsFor: string | null = null; // caller turn the on-screen directions respond to
  private asked: DirectionCategory[] = [];
  private answered = new Set<DirectionCategory>();
  private locked = false;
  private seq = 0;
  private planner: SingleFlight;
  private analyst: SingleFlight;
  ended = false;

  constructor(
    private ctx: CallContext,
    private emit: (m: DeskServerMsg) => void,
    private revision: () => number,
  ) {
    this.planner = new SingleFlight(() => this.runPlanner(), () => !this.ended);
    this.analyst = new SingleFlight(() => this.runAnalyst(), () => !this.ended);
  }

  // ---------------------------------------------------------------- turns

  addTurn(speaker: Speaker, text: string): Turn {
    const n = this.turns.length + 1;
    const turn: Turn = { turnId: `t${n}`, n, speaker, text, status: "final" };
    this.turns.push(turn);
    this.emit({ type: "turn.final", turn });
    if (speaker === "caller") this.onCallerTurn(turn);
    return turn;
  }

  cutTurn(turnId: string) {
    const t = this.turns.find((x) => x.turnId === turnId);
    if (t) t.status = "cut";
  }

  private lastCallerTurn() {
    return [...this.turns].reverse().find((t) => t.speaker === "caller") ?? null;
  }

  private onCallerTurn(turn: Turn) {
    // Lane 1: rules (synchronous).
    const t0 = performance.now();
    const hits = flagTurn(turn.text);
    hits.forEach((id) => this.upsertSign(id, turn.turnId, "rules", "provisional"));
    this.emit({ type: "lane.result", lane: "rules", model: "regex", turnId: turn.turnId, ms: Math.round(performance.now() - t0), ok: true, note: hits.join(", ") || "no flags" });
    this.rescore();
    this.stockDirections(turn);

    // Lane 2: Hydrogen fast check of this turn.
    const snapshot = [...this.turns];
    void fastCheck(snapshot, turn).then((r) => {
      if (this.ended) return;
      this.emit({ type: "lane.result", lane: "hydrogen", model: r.model, turnId: turn.turnId, ms: r.ms, ok: r.ok, note: r.ok ? r.signs.map((s) => s.id).join(", ") || "no signs" : r.error });
      const before = [...this.signs.values()].filter((s) => s.status !== "removed").length;
      r.signs.forEach((s) => this.upsertSign(s.id, s.evidenceTurnId, "hydrogen", "provisional"));
      const after = [...this.signs.values()].filter((s) => s.status !== "removed").length;
      if (after === before) return;
      this.rescore();
      if (this.directionsFor === turn.turnId && this.directions.every((d) => d.source === "stock")) this.stockDirections(turn);
    });

    // Lanes 3 and 4: planner and analyst, one in flight each.
    this.planner.kick();
    this.analyst.kick();
  }

  // ---------------------------------------------------------------- signs and score

  private upsertSign(id: string, turnId: string, lane: Lane, status: SignStatus) {
    const def = SIGNS[id];
    if (!def) return;
    const cur = this.signs.get(id);
    if (!cur) {
      const s: Sign = { id, label: def.label, weight: def.weight, evidenceTurnId: turnId, status, source: lane, ...(status === "confirmed" ? { confirmedBy: lane } : {}) };
      this.signs.set(id, s);
      this.emit({ type: "risk.signal", sign: s });
      return;
    }
    if (status === "confirmed" && cur.status !== "confirmed") {
      Object.assign(cur, { status: "confirmed", confirmedBy: lane, evidenceTurnId: cur.status === "removed" ? turnId : cur.evidenceTurnId });
      this.emit({ type: "risk.signal", sign: cur });
    } else if (status === "provisional" && cur.status === "removed" && lane !== "rules" && turnId !== cur.evidenceTurnId) {
      // New evidence on a later turn brings back a sign Neon removed.
      Object.assign(cur, { status: "provisional", evidenceTurnId: turnId, source: lane });
      this.emit({ type: "risk.signal", sign: cur });
    }
  }

  private rescore() {
    const risk = scoreRisk([...this.signs.values()], this.locked);
    this.locked = risk.locked;
    this.emit({ type: "risk.level", risk });
  }

  private has(id: string) {
    const s = this.signs.get(id);
    return !!s && s.status !== "removed";
  }

  // ---------------------------------------------------------------- planner (Hydrogen)

  private async runPlanner() {
    const turns = [...this.turns];
    const forTurn = this.lastCallerTurn();
    if (!forTurn) return;
    const r = await plan({
      ctx: this.ctx,
      turns,
      signs: [...this.signs.values()].filter((s) => s.status !== "removed").map((s) => s.id),
      notes: Object.fromEntries([...this.notes].map(([k, v]) => [k, v.value])),
      onScreen: this.directions.map((d) => ({ category: d.category, label: d.label })),
      asked: this.asked,
      answered: [...this.answered],
    });
    if (this.ended) return;
    const stale = this.lastCallerTurn()?.turnId !== forTurn.turnId;
    const out = r.out;
    this.emit({
      type: "lane.result", lane: "planner", model: r.model, turnId: forTurn.turnId, ms: r.ms, ok: !!out,
      note: out ? `${out.directions.length} directions${stale ? " (stale: newer turn arrived, not shown)" : ""}${out.dropped.length ? `; guard dropped ${out.dropped.join("; ")}` : ""}` : r.error,
    });
    if (!out) return;
    for (const a of out.answered) {
      this.answered.add(a.category);
      for (const d of this.directions.filter((x) => x.category === a.category)) this.withdraw(d, "already answered", a.evidenceTurnId);
    }
    if (stale || !out.directions.length) return;
    this.setDirections(out.directions.map((d) => ({ ...d, id: this.nextId(), source: "planner" as const, revision: this.revision() })), forTurn.turnId);
  }

  // ---------------------------------------------------------------- analyst (Neon)

  private async runAnalyst() {
    const turns = [...this.turns];
    const forTurn = this.lastCallerTurn();
    if (!forTurn) return;
    const callerIds = new Set(turns.filter((t) => t.speaker === "caller").map((t) => t.turnId));
    const r = await analyze({
      ctx: this.ctx,
      turns,
      provisional: [...this.signs.values()].filter((s) => s.status === "provisional").map((s) => ({ id: s.id, evidenceTurnId: s.evidenceTurnId })),
      notes: Object.fromEntries([...this.notes].map(([k, v]) => [k, v.value])),
    });
    if (this.ended) return;
    const out = r.out;
    this.emit({
      type: "lane.result", lane: "neon", model: r.model, turnId: forTurn.turnId, ms: r.ms, ok: !!out,
      note: out ? `${out.signs.length} signs, ${out.notes.length} notes${out.dropped.length ? `; dropped ${out.dropped.join("; ")}` : ""}` : r.error,
    });
    if (!out) return;

    // Neon's list confirms; provisional signs from turns it saw, which it left out, are removed.
    const neonIds = new Set(out.signs.map((s) => s.id));
    out.signs.forEach((s) => this.upsertSign(s.id, s.evidenceTurnId, "neon", "confirmed"));
    for (const s of this.signs.values()) {
      if (s.status === "provisional" && callerIds.has(s.evidenceTurnId) && !neonIds.has(s.id)) {
        s.status = "removed";
        this.emit({ type: "risk.signal", sign: s });
      }
    }
    this.rescore();

    // A changed value keeps the old one as history ("was $280 · t4").
    for (const n of out.notes) {
      const cur = this.notes.get(n.field);
      if (cur && cur.value.trim().toLowerCase() === n.value.trim().toLowerCase()) continue;
      this.notes.set(n.field, { value: n.value, turnId: n.evidenceTurnId });
      this.emit({ type: "notes.update", field: n.field, value: n.value, evidenceTurnId: n.evidenceTurnId, ...(cur ? { previous: { value: cur.value, turnId: cur.turnId } } : {}) });
    }
    if (out.decision) this.emit({ type: "decision.open", text: out.decision.text, evidenceTurnId: out.decision.evidenceTurnId });

    // Once locked, the stock board switches to callback / decline right away.
    const last = this.lastCallerTurn();
    if (this.locked && last && this.directions.every((d) => d.source === "stock")) this.stockDirections(last);
  }

  // ---------------------------------------------------------------- directions

  /** Instant, rule-based directions so Alex always has something to tap. */
  private stockDirections(turn: Turn) {
    const pick: { key: string; why: string; whyTurnId: string | null }[] = [];
    const ev = (id: string) => this.signs.get(id)?.evidenceTurnId ?? turn.turnId;
    const done = (c: DirectionCategory) => this.asked.includes(c) || this.answered.has(c);
    if (this.locked || this.has("code")) pick.push({ key: "decline", why: "A code or payment was requested", whyTurnId: ev(this.has("code") ? "code" : "money") });
    if (this.has("money") && !done("offer_callback")) pick.push({ key: "callback", why: "Money requested, identity only claimed", whyTurnId: ev("money") });
    if ((this.has("new_number") || this.has("emergency") || !this.ctx.inContacts) && !done("verify_identity"))
      pick.push({ key: "family", why: this.has("new_number") ? "New number, identity only claimed" : "Caller is not in contacts", whyTurnId: this.has("new_number") ? ev("new_number") : turn.turnId });
    if (this.has("deadline") && !done("slow_down")) pick.push({ key: "slow", why: "Pressure or a deadline", whyTurnId: ev("deadline") });
    if (!this.has("money") && !done("probe_details")) pick.push({ key: "need", why: "Request is still unclear", whyTurnId: turn.turnId });
    if (pick.length < 3 && !done("probe_details")) pick.push({ key: "who", why: "Caller's details are thin", whyTurnId: turn.turnId });

    const seen = new Set<string>();
    const list = pick.filter((p) => !seen.has(p.key) && seen.add(p.key)).slice(0, 3);
    const dirs: Direction[] = list.map((p, i) => {
      const s = STOCK.find((x) => x.key === p.key)!;
      return { id: this.nextId(), category: s.category, label: s.label, say: s.say, why: p.why, whyTurnId: p.whyTurnId, suggested: i === 0, source: "stock", revision: this.revision() };
    });

    // "Ask what they need" is answered as soon as a money request shows up.
    if (this.has("money")) {
      for (const d of this.directions.filter((x) => x.label === "Ask what they need")) this.withdraw(d, "already answered", ev("money"));
    }
    this.setDirections(dirs, turn.turnId);
  }

  private setDirections(dirs: Direction[], forTurn: string) {
    this.directions = dirs;
    this.directionsFor = forTurn;
    this.emit({ type: "directions", directions: dirs, revision: this.revision() });
  }

  private withdraw(d: Direction, reason: string, evidenceTurnId: string | null) {
    this.directions = this.directions.filter((x) => x.id !== d.id);
    this.emit({ type: "directions.withdrawn", directionId: d.id, label: d.label, reason, evidenceTurnId });
  }

  /** Re-issue on-screen directions under a new control revision (after delegate/takeback). */
  reissue() {
    this.directions = this.directions.map((d) => ({ ...d, revision: this.revision() }));
    this.emit({ type: "directions", directions: this.directions, revision: this.revision() });
  }

  findDirection(id: string) {
    return this.directions.find((d) => d.id === id) ?? null;
  }

  /** A tap was accepted: one question at a time, so the board clears until the caller answers. */
  picked(d: Direction) {
    this.asked.push(d.category);
    this.directions = [];
    this.emit({ type: "directions", directions: [], revision: this.revision() });
  }

  private nextId() {
    return `d${++this.seq}`;
  }
}
