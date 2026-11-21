// Event contract for the ReVoice brain (v3 plan), used by the test desk today and the
// phone app later. App code owns the floor, taps, scores and thresholds; models only propose.

export type Speaker = "caller" | "alex" | "agent";
export type Floor = "alex" | "agent" | "ended";
export type Level = "Low" | "Medium" | "High";
/** One lane per box in the architecture diagram (README). */
export type Lane = "rules" | "flash" | "risk" | "notes" | "planner" | "supervisor" | "review";

export interface Turn {
  turnId: string; // "t1", "t2", ...
  n: number;
  speaker: Speaker;
  text: string;
  status?: "final" | "cut";
}

export type SignStatus = "provisional" | "confirmed" | "removed";
export interface Sign {
  id: string; // catalog id, e.g. "money"
  label: string;
  weight: number;
  evidenceTurnId: string;
  status: SignStatus;
  source: Lane; // who flagged it first
  confirmedBy?: Lane;
}

export interface RiskLevel {
  level: Level;
  score: number;
  locked: boolean; // "High risk: confirmed"
  provisional: boolean; // level depends on signs Neon hasn't confirmed yet
}

export type DirectionCategory = "verify_identity" | "offer_callback" | "probe_details" | "slow_down" | "decline" | "take_message";
export interface Direction {
  id: string;
  category: DirectionCategory;
  label: string;
  say: string; // exact words the agent will speak
  why: string;
  whyTurnId: string | null;
  suggested: boolean;
  confidence: number; // 0..1, how sure the lane is this is the right next line; the auto-speaker picks the highest
  source: "stock" | "flash" | "planner";
  revision: number;
}

export interface ScenarioInfo {
  id: string;
  title: string;
  kind: "scam" | "legit" | "everyday";
  caller: string;
  from: string;
  inContacts: boolean;
  lines: number;
  expected: { level: Level; verdict: string };
}

export interface CallReview {
  callId: string;
  model: string;
  ms: number;
  summary: string;
  verdict: "scam" | "legit" | "unclear";
  finalLevel: Level;
  locked: boolean;
  followUps: { action: string; why: string }[]; // drafts only: Alex approves each one
  evals: { name: string; pass: boolean; detail: string }[];
  latency: Partial<Record<Lane, { runs: number; medianMs: number; failures: number }>>;
}

export type FollowUpKind = "draft_text_message" | "draft_report" | "block_number" | "set_reminder";
export type FollowUpReportTarget = "bank" | "ftc" | "police" | "other";

/** Concrete follow-up action proposed by the follow-up agent. Nothing executes until Alex approves. */
export type FollowUpAction =
  | { id: string; kind: "draft_text_message"; title: string; details: string; payload: { to: string; body: string } }
  | { id: string; kind: "draft_report"; title: string; details: string; payload: { to: FollowUpReportTarget; body: string } }
  | { id: string; kind: "block_number"; title: string; details: string; payload: { number: string } }
  | { id: string; kind: "set_reminder"; title: string; details: string; payload: { text: string; when: string } };

/** Desk (test harness) or phone app → server. The app joins a live phone call by callId ("latest" = newest). */
export type DeskClientMsg =
  | { type: "join"; role: "desk"; callId: string }
  | { type: "join"; role: "app"; callId: string; token?: string } // token = APP_TOKEN (see server/src/auth.ts)
  | { type: "desk.start"; scenarioId: string; mode?: "live" | "script" | "mic" } // live: Gemini plays the caller; mic: you are the caller (binary 16 kHz PCM frames on the same socket)
  | { type: "desk.next" } // play the next scripted caller line
  | { type: "desk.say"; speaker: "caller" | "alex"; text: string } // type a line live
  | { type: "desk.agentPlaying"; turnId: string } // the desk started playing this agent line (barge-in can cut it now)
  | { type: "desk.callerDone"; turnId: string } // the desk finished playing this caller line out loud
  | { type: "desk.agentDone"; turnId: string } // the client finished playing an agent line
  | { type: "control.delegate"; actionId: string; revision: number }
  | { type: "control.takeback"; actionId: string; revision: number; localSilenceMs: number; cutTurnId?: string }
  | { type: "direction.pick"; actionId: string; revision: number; directionId: string }
  | { type: "call.end"; actionId: string; revision: number }
  | { type: "followup.approve"; actionId: string; followupId: string }
  | { type: "followup.dismiss"; followupId: string };

/** Server → desk */
export type DeskServerMsg =
  | { type: "desk.scenarios"; scenarios: ScenarioInfo[] }
  | { type: "call.started"; callId: string; scenario: ScenarioInfo; script: string[] }
  | { type: "call.ended"; reason: string }
  | { type: "state"; floor: Floor; revision: number; nextLine: number; totalLines: number }
  | { type: "turn.final"; turn: Turn }
  | { type: "caption.interim"; speaker: Speaker; text: string } // live words before the line is final
  | { type: "call.review"; review: CallReview }
  | { type: "followup.proposed"; actions: FollowUpAction[] }
  | { type: "followup.result"; followupId: string; ok: boolean; detail: string }
  | { type: "agent.say"; turnId: string; text: string; revision: number; directionId: string | null; auto?: boolean }
  | { type: "agent.cut"; turnId: string }
  | { type: "agent.done"; turnId: string }
  /** A short backchannel ("Mm-hm.") while the real reply loads; not a turn, never in the transcript. */
  | { type: "agent.ack"; text: string }
  // The agent will say the best direction on its own in inMs unless Alex taps first (null directionId = cancelled).
  | { type: "agent.autoPick"; directionId: string | null; inMs: number; revision: number }
  | { type: "risk.signal"; sign: Sign }
  | { type: "risk.level"; risk: RiskLevel }
  | { type: "notes.update"; field: string; value: string; evidenceTurnId: string; previous?: { value: string; turnId: string } }
  | { type: "decision.open"; text: string; evidenceTurnId: string }
  | { type: "directions"; directions: Direction[]; revision: number }
  | { type: "directions.withdrawn"; directionId: string; label: string; reason: string; evidenceTurnId: string | null }
  | { type: "lane.result"; lane: Lane; model: string; turnId: string; ms: number; ok: boolean; note?: string }
  | { type: "action.accepted"; actionId: string; revision: number }
  | { type: "action.rejected"; actionId: string; revision: number; reason: string }
  | { type: "error"; message: string };
