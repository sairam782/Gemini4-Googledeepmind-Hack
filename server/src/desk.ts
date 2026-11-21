import type { WebSocket } from "ws";
import type { DeskClientMsg, DeskServerMsg, Floor } from "../../shared/brain.ts";
import { CallBrain } from "./brain/orchestrator.ts";
import { INTRO, guardSay } from "./brain/catalog.ts";
import { SCENARIOS, scenarioInfo, type Scenario } from "./scenarios.ts";

/**
 * Test desk: plays scripted calls through the brain in place of Twilio.
 * Floor, revision and one-shot taps are enforced here, the same way the phone flow will.
 */
export class DeskSession {
  private scenario: Scenario | null = null;
  private brain: CallBrain | null = null;
  private floor: Floor = "ended";
  private revision = 0;
  private nextLine = 0;
  private introduced = false;
  private speaking: string | null = null; // agent turn currently playing
  private consumed = new Set<string>();

  constructor(private ws: WebSocket) {
    this.send({ type: "desk.scenarios", scenarios: SCENARIOS.map(scenarioInfo) });
  }

  private send(m: DeskServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  private state() {
    this.send({ type: "state", floor: this.floor, revision: this.revision, nextLine: this.nextLine, totalLines: this.scenario?.script.length ?? 0 });
  }

  close() {
    if (this.brain) this.brain.ended = true;
  }

  handle(m: DeskClientMsg) {
    switch (m.type) {
      case "desk.start": return this.start(m.scenarioId);
      case "desk.next": return this.next();
      case "desk.say": return this.say(m.speaker, m.text);
      case "desk.agentDone":
        if (this.speaking === m.turnId) this.speaking = null;
        return;
      case "control.delegate":
      case "control.takeback":
      case "direction.pick":
      case "call.end":
        return this.control(m);
    }
  }

  private start(id: string) {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return this.send({ type: "error", message: `unknown scenario ${id}` });
    if (this.brain) this.brain.ended = true;
    this.scenario = sc;
    this.floor = "alex";
    this.revision++;
    this.nextLine = 0;
    this.introduced = false;
    this.speaking = null;
    this.consumed.clear();
    this.brain = new CallBrain({ from: sc.from, inContacts: sc.inContacts }, (msg) => this.send(msg), () => this.revision);
    this.send({ type: "call.started", callId: `${sc.id}-${Date.now()}`, scenario: scenarioInfo(sc), script: sc.script });
    this.state();
    this.brain.addTurn("alex", "Hello?");
  }

  private next() {
    if (!this.brain || !this.scenario || this.floor === "ended") return;
    if (this.nextLine >= this.scenario.script.length) return this.send({ type: "error", message: "script finished" });
    this.brain.addTurn("caller", this.scenario.script[this.nextLine++]);
    this.state();
  }

  private say(speaker: "caller" | "alex", text: string) {
    if (!this.brain || this.floor === "ended" || !text.trim()) return;
    if (speaker === "alex" && this.floor === "agent") {
      return this.send({ type: "error", message: "Alex's mic is muted while the agent has the floor. Take back first." });
    }
    this.brain.addTurn(speaker, text.trim().slice(0, 500));
  }

  private agentSay(text: string, directionId: string | null) {
    const blocked = guardSay(text);
    if (blocked) return this.send({ type: "error", message: `guard blocked agent line (${blocked})` });
    const turn = this.brain!.addTurn("agent", text);
    this.speaking = turn.turnId;
    this.send({ type: "agent.say", turnId: turn.turnId, text, revision: this.revision, directionId });
  }

  private control(m: Extract<DeskClientMsg, { actionId: string }>) {
    const reject = (reason: string) => this.send({ type: "action.rejected", actionId: m.actionId, revision: m.revision, reason });
    if (!this.brain) return reject("no call");
    if (this.consumed.has(m.actionId)) return reject("duplicate");
    const alwaysAllowed = m.type === "control.takeback" || m.type === "call.end";
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
      if (this.speaking && m.cutTurnId === this.speaking) {
        this.brain.cutTurn(this.speaking);
        this.send({ type: "agent.cut", turnId: this.speaking });
      }
      this.speaking = null;
      if (this.floor === "agent") this.floor = "alex";
      this.revision++;
      this.accept(m.actionId);
      this.brain.reissue();
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
      this.floor = "ended";
      this.revision++;
      this.brain.ended = true;
      this.accept(m.actionId);
      this.send({ type: "call.ended", reason: "Alex ended the call" });
    }
    this.state();
  }

  private accept(actionId: string) {
    this.send({ type: "action.accepted", actionId, revision: this.revision });
  }
}
