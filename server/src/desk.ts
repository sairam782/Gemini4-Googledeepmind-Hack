import type { WebSocket } from "ws";
import type { DeskClientMsg, DeskServerMsg } from "../../shared/brain.ts";
import { LiveCall, findCall } from "./call.ts";
import { SCENARIOS, scenarioInfo, type Scenario } from "./scenarios.ts";
import { SimCaller } from "./brain/callerSim.ts";

/**
 * A socket watching and steering one call.
 *  - role "desk": the test harness. Starts simulated calls (stand-in for Twilio); the browser plays the agent.
 *    mode "live" (default): Gemini plays the caller and answers on its own. mode "script": fixed lines, one per Next.
 *  - role "app":  Alex's phone app. Joins a live phone call by callId ("latest" = newest).
 */
export class DeskSession {
  private call: LiveCall | null = null;
  private scenario: Scenario | null = null;
  private nextLine = 0;
  private unsub: (() => void) | null = null;
  private sim: SimCaller | null = null;

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
    this.sim?.stop();
    // A scripted call has no other owner; a phone call keeps running when the app disconnects.
    if (this.scenario && this.call && !this.call.ended) this.call.end("desk closed");
  }

  handle(m: DeskClientMsg) {
    switch (m.type) {
      case "desk.start": return this.start(m.scenarioId, m.mode ?? "live");
      case "desk.next": return this.next();
      case "desk.say":
        if (!this.call) return;
        return m.speaker === "alex" ? this.call.alex(m.text) : this.call.caller(m.text);
      case "desk.callerDone":
        return this.call?.callerAudioDone(m.turnId);
      case "desk.agentDone":
        return this.call?.agentDone(m.turnId);
      case "call.label":
        return this.call?.setLabel(m.label);
      case "control.delegate":
      case "control.takeback":
      case "direction.pick":
      case "call.end":
        if (!this.call) return this.send({ type: "action.rejected", actionId: m.actionId, revision: m.revision, reason: "no call" });
        return this.call.control(m);
      case "followup.approve":
        if (!this.call) return this.send({ type: "followup.result", followupId: m.followupId, ok: false, detail: "no call" });
        return this.call.approveFollowUp(m.actionId, m.followupId);
      case "followup.dismiss":
        if (!this.call) return this.send({ type: "followup.result", followupId: m.followupId, ok: false, detail: "no call" });
        return this.call.dismissFollowUp(m.followupId);
    }
  }

  private start(id: string, mode: "live" | "script") {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return this.send({ type: "error", message: `unknown scenario ${id}` });
    if (this.call && !this.call.ended) this.call.end("restarted");
    this.sim?.stop();
    this.sim = null;
    this.scenario = sc;
    this.nextLine = 0;
    const call = new LiveCall(`${sc.id}-${Date.now()}`, { from: sc.from, inContacts: sc.inContacts }, sc.expected, { source: "desk", scenarioId: sc.id });
    if (mode === "script") call.lineInfo = () => ({ nextLine: this.nextLine, totalLines: sc.script.length });
    this.send({ type: "call.started", callId: call.id, scenario: scenarioInfo(sc), script: sc.script });
    this.attach(call);
    call.state();
    call.brain.addTurn("alex", "Hello?");
    if (mode === "live") {
      call.waitForCallerAudio = true;
      this.sim = new SimCaller(call, sc);
      this.sim.start();
    }
  }

  private next() {
    const call = this.call;
    if (!call || !this.scenario || call.ended) return;
    if (this.sim) return this.send({ type: "error", message: "live caller: the caller answers on its own" });
    if (this.nextLine >= this.scenario.script.length) return this.send({ type: "error", message: "script finished" });
    call.caller(this.scenario.script[this.nextLine++]);
    call.state();
  }
}
