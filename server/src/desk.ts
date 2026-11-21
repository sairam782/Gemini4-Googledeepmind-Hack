import type { WebSocket } from "ws";
import type { DeskClientMsg, DeskServerMsg } from "../../shared/brain.ts";
import { LiveCall, findCall } from "./call.ts";
import { SCENARIOS, scenarioInfo, type Scenario } from "./scenarios.ts";

/**
 * A socket watching and steering one call.
 *  - role "desk": the test harness. Starts scripted calls (stand-in for Twilio); the browser plays the agent.
 *  - role "app":  Alex's phone app. Joins a live phone call by callId ("latest" = newest).
 */
export class DeskSession {
  private call: LiveCall | null = null;
  private scenario: Scenario | null = null;
  private nextLine = 0;
  private unsub: (() => void) | null = null;

  constructor(private ws: WebSocket, role: "desk" | "app", callId: string) {
    if (role === "desk") {
      this.send({ type: "desk.scenarios", scenarios: SCENARIOS.map(scenarioInfo) });
    } else {
      const call = findCall(callId);
      if (!call) this.send({ type: "error", message: `no live call ${callId}` });
      else this.attach(call);
    }
  }

  private send(m: DeskServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  private attach(call: LiveCall) {
    this.unsub?.();
    this.call = call;
    this.unsub = call.subscribe((m) => this.send(m));
  }

  close() {
    this.unsub?.();
    // A scripted call has no other owner; a phone call keeps running when the app disconnects.
    if (this.scenario && this.call && !this.call.ended) this.call.end("desk closed");
  }

  handle(m: DeskClientMsg) {
    switch (m.type) {
      case "desk.start": return this.start(m.scenarioId);
      case "desk.next": return this.next();
      case "desk.say":
        if (!this.call) return;
        return m.speaker === "alex" ? this.call.alex(m.text) : this.call.caller(m.text);
      case "desk.agentDone":
        return this.call?.agentDone(m.turnId);
      case "control.delegate":
      case "control.takeback":
      case "direction.pick":
      case "call.end":
        if (!this.call) return this.send({ type: "action.rejected", actionId: m.actionId, revision: m.revision, reason: "no call" });
        return this.call.control(m);
    }
  }

  private start(id: string) {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return this.send({ type: "error", message: `unknown scenario ${id}` });
    if (this.call && !this.call.ended) this.call.end("restarted");
    this.scenario = sc;
    this.nextLine = 0;
    const call = new LiveCall(`${sc.id}-${Date.now()}`, { from: sc.from, inContacts: sc.inContacts }, sc.expected);
    call.lineInfo = () => ({ nextLine: this.nextLine, totalLines: sc.script.length });
    this.send({ type: "call.started", callId: call.id, scenario: scenarioInfo(sc), script: sc.script });
    this.attach(call);
    call.state();
    call.brain.addTurn("alex", "Hello?");
  }

  private next() {
    const call = this.call;
    if (!call || !this.scenario || call.ended) return;
    if (this.nextLine >= this.scenario.script.length) return this.send({ type: "error", message: "script finished" });
    call.caller(this.scenario.script[this.nextLine++]);
    call.state();
  }
}
