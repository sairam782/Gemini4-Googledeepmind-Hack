import type { WebSocket } from "ws";
import type { DeskClientMsg, DeskServerMsg } from "../../shared/brain.ts";
import { LiveCall, findCall } from "./call.ts";
import { SCENARIOS, scenarioInfo, type Scenario } from "./scenarios.ts";
import { SimCaller } from "./brain/callerSim.ts";
import { Transcriber } from "./transcribe.ts";

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
  private mic: Transcriber | null = null; // mic mode: the person at the desk is the caller

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
    this.mic?.close();
    // A scripted call has no other owner; a phone call keeps running when the app disconnects.
    if (this.scenario && this.call && !this.call.ended) this.call.end("desk closed");
  }

  handle(m: DeskClientMsg) {
    switch (m.type) {
      case "desk.start": return this.start(m.scenarioId, m.mode === "mic" || m.mode === "script" ? m.mode : "live");
      case "desk.next": return this.next();
      case "desk.say":
        if (!this.call) return;
        return m.speaker === "alex" ? this.call.alex(m.text) : this.call.caller(m.text);
      case "desk.agentPlaying":
        return this.call?.agentPlaying(m.turnId);
      case "desk.callerDone":
        return this.call?.callerAudioDone(m.turnId);
      case "desk.agentDone":
        return this.call?.agentDone(m.turnId);
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

  /** Mic mode: PCM frames from the browser go to Gemini Live transcription, as on a phone line. */
  audio(pcm16k: Buffer) {
    if (this.mic && this.call && !this.call.ended && pcm16k.length && pcm16k.length < 64_000) this.mic.push(pcm16k);
  }

  private start(id: string, mode: "live" | "script" | "mic") {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return this.send({ type: "error", message: `unknown scenario ${id}` });
    if (this.call && !this.call.ended) this.call.end("restarted");
    this.sim?.stop();
    this.sim = null;
    this.mic?.close();
    this.mic = null;
    this.scenario = sc;
    this.nextLine = 0;
    const call = new LiveCall(`${sc.id}-${Date.now()}`, { from: sc.from, inContacts: sc.inContacts }, sc.expected);
    if (mode === "script") call.lineInfo = () => ({ nextLine: this.nextLine, totalLines: sc.script.length });
    this.send({ type: "call.started", callId: call.id, scenario: scenarioInfo(sc), script: sc.script });
    this.attach(call);
    call.state();
    call.brain.addTurn("alex", "Hello?");
    if (mode === "mic") {
      const c = call;
      // Speech-to-text already adds ~1-2 s after you stop talking, so the agent answers a little sooner here.
      c.autoSpeakMs = Number(process.env.MIC_AUTO_SPEAK_MS ?? 3000);
      // Speakers instead of headphones: the agent's own voice can leak into the mic. Drop caller text that
      // mostly repeats what the agent just said while it is (or was just) audible.
      // Keep the last few agent lines: a delayed transcript of the intro can arrive after the next line started.
      const recent: { text: string; at: number }[] = [];
      let interimWasEcho = false;
      const echo = (t: string, final: boolean) => {
        const now = Date.now();
        const lines = recent.filter((r) => now - r.at < 12_000).map((r) => r.text);
        const isEcho = (c.agentAudible(4000) || (final && interimWasEcho)) && lines.some((a) => echoOf(t, a));
        interimWasEcho = final ? false : isEcho;
        return isEcho;
      };
      this.mic = new Transcriber(
        {
          interim: (t) => !echo(t, false) && c.interim("caller", t),
          final: (t) => !echo(t, true) && c.caller(t),
          error: (message) => c.emit({ type: "error", message }),
        },
        "caller",
      );
      c.subscribe((m) => {
        if (m.type === "agent.say") {
          recent.push({ text: m.text, at: Date.now() });
          if (recent.length > 3) recent.shift();
        }
        if (m.type === "call.ended") this.mic?.close();
      }, false);
    }
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

const wordsOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
/**
 * True when `heard` is the agent's own voice picked up by the mic: most of its words are the agent's, and
 * (for 3+ words) it repeats a run of three in order. A real answer that reuses the question's words
 * ("my full name is Maya" after "can you tell me your full name?") is not an echo.
 */
export function echoOf(heard: string, agentSaid: string) {
  const h = wordsOf(heard);
  if (!h.length || !agentSaid) return false;
  const aw = wordsOf(agentSaid);
  const a = new Set(aw);
  const ratio = h.filter((w) => a.has(w)).length / h.length;
  if (h.length < 3) return ratio === 1;
  if (ratio < 0.75) return false;
  const tri = new Set(aw.slice(2).map((w, i) => `${aw[i]} ${aw[i + 1]} ${w}`));
  return h.slice(2).some((w, i) => tri.has(`${h[i]} ${h[i + 1]} ${w}`));
}
