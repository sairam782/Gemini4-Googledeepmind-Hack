import { useEffect, useRef, useState } from "react";
import type {
  CallReview, DeskClientMsg, DeskServerMsg, Direction, Floor, Lane, RiskLevel, ScenarioInfo, Sign, Turn,
} from "../../../shared/brain.ts";
import { VoicePlayer } from "../lib/voice.ts";

const AGENT_VOICE = "Kore";
const LANE_NAMES: Record<Exclude<Lane, "review">, string> = {
  rules: "Rules", flash: "Flash-Lite", risk: "Risk (Hydrogen)", notes: "Notes (Hydrogen)", planner: "Planner (Argon)", supervisor: "Supervisor (Neon)",
};
const CALLER_VOICE = "Puck";
const uid = () => crypto.randomUUID();

interface Note { value: string; turnId: string; history: { value: string; turnId: string }[] }
interface LaneStat { ms: number; ok: boolean; note?: string; turnId: string; runs: number }

/** Test desk for the brain: scripted calls stand in for Twilio. */
export function DeskPage() {
  const [ws, setWs] = useState<"connecting" | "open" | "closed">("connecting");
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [scenarioId, setScenarioId] = useState("maya");
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [script, setScript] = useState<string[]>([]);
  const [floor, setFloor] = useState<Floor>("ended");
  const [revision, setRevision] = useState(0);
  const [nextLine, setNextLine] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [signs, setSigns] = useState<Record<string, Sign>>({});
  const [risk, setRisk] = useState<RiskLevel | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [decision, setDecision] = useState<{ text: string; evidenceTurnId: string } | null>(null);
  const [dirs, setDirs] = useState<Direction[]>([]);
  const [withdrawn, setWithdrawn] = useState<{ label: string; reason: string; turnId: string | null }[]>([]);
  const [lanes, setLanes] = useState<Partial<Record<Lane, LaneStat>>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [auto, setAuto] = useState(false);
  const [typed, setTyped] = useState("");
  const [review, setReview] = useState<CallReview | null>(null);
  const [m, setM] = useState({ accepted: 0, rejected: 0, cuts: 0, tapToAudio: null as number | null, takeback: null as number | null });

  const sock = useRef<WebSocket | null>(null);
  const voice = useRef<VoicePlayer | null>(null);
  const refs = useRef({ voiceOn, auto, revision, floor, nextLine, total: 0, tapAt: 0 });
  refs.current = { ...refs.current, voiceOn, auto, revision, floor, nextLine, total: script.length };

  const send = (msg: DeskClientMsg) => sock.current?.readyState === WebSocket.OPEN && sock.current.send(JSON.stringify(msg));
  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2500);
  };

  // ---- socket
  useEffect(() => {
    let closed = false;
    const connect = () => {
      setWs("connecting");
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      sock.current = s;
      s.onopen = () => {
        setWs("open");
        s.send(JSON.stringify({ type: "join", role: "desk", callId: "desk" }));
      };
      s.onmessage = (e) => onMsg(JSON.parse(e.data));
      s.onclose = () => {
        setWs("closed");
        if (!closed) setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      sock.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function player() {
    return (voice.current ??= new VoicePlayer());
  }

  function onMsg(msg: DeskServerMsg) {
    setEvents((e) => [...e.slice(-80), `${new Date().toLocaleTimeString()}  ${JSON.stringify(msg).slice(0, 220)}`]);
    switch (msg.type) {
      case "desk.scenarios":
        setScenarios(msg.scenarios);
        break;
      case "call.started":
        setScenario(msg.scenario);
        setScript(msg.script);
        setTurns([]); setSigns({}); setRisk(null); setNotes({}); setDecision(null); setDirs([]); setWithdrawn([]); setLanes({}); setReview(null);
        setM({ accepted: 0, rejected: 0, cuts: 0, tapToAudio: null, takeback: null });
        if (refs.current.voiceOn) msg.script.forEach((l) => void player().clip(l, CALLER_VOICE).catch(() => {}));
        void player().clip("Hi, I'm Alex's AI assistant. Alex is listening. Who's calling, and how can I help?", AGENT_VOICE).catch(() => {});
        break;
      case "state":
        setFloor(msg.floor); setRevision(msg.revision); setNextLine(msg.nextLine);
        break;
      case "turn.final":
        setTurns((t) => [...t, msg.turn]);
        if (msg.turn.speaker === "caller" && refs.current.voiceOn) {
          void player().clip(msg.turn.text, CALLER_VOICE).then((b) => player().play(b)).catch(() => {});
        }
        break;
      case "agent.say":
        void speakAgent(msg.turnId, msg.text);
        break;
      case "agent.cut":
        setTurns((t) => t.map((x) => (x.turnId === msg.turnId ? { ...x, status: "cut" } : x)));
        break;
      case "risk.signal":
        setSigns((s) => ({ ...s, [msg.sign.id]: msg.sign }));
        break;
      case "risk.level":
        setRisk(msg.risk);
        break;
      case "notes.update":
        setNotes((n) => {
          const cur = n[msg.field];
          return { ...n, [msg.field]: { value: msg.value, turnId: msg.evidenceTurnId, history: cur ? [{ value: cur.value, turnId: cur.turnId }, ...cur.history] : [] } };
        });
        break;
      case "decision.open":
        setDecision({ text: msg.text, evidenceTurnId: msg.evidenceTurnId });
        break;
      case "directions":
        setDirs(msg.directions);
        if (refs.current.voiceOn) msg.directions.forEach((d) => void player().clip(d.say, AGENT_VOICE).catch(() => {})); // pre-render
        break;
      case "directions.withdrawn":
        setDirs((d) => d.filter((x) => x.id !== msg.directionId));
        setWithdrawn((w) => [{ label: msg.label, reason: msg.reason, turnId: msg.evidenceTurnId }, ...w].slice(0, 4));
        break;
      case "lane.result":
        setLanes((l) => ({ ...l, [msg.lane]: { ms: msg.ms, ok: msg.ok, note: msg.note, turnId: msg.turnId, runs: (l[msg.lane]?.runs ?? 0) + 1 } }));
        break;
      case "action.accepted":
        setM((x) => ({ ...x, accepted: x.accepted + 1 }));
        break;
      case "action.rejected":
        setM((x) => ({ ...x, rejected: x.rejected + 1 }));
        flash(`Tap rejected: ${msg.reason}`);
        break;
      case "call.review":
        setReview(msg.review);
        break;
      case "call.ended":
        player().stop();
        flash(msg.reason);
        break;
      case "error":
        flash(msg.message);
        break;
    }
  }

  async function speakAgent(turnId: string, text: string) {
    setSpeaking(turnId);
    const rev = refs.current.revision;
    let result: "ended" | "stopped" = "ended";
    if (refs.current.voiceOn) {
      try {
        const buf = await player().clip(text, AGENT_VOICE);
        if (refs.current.floor !== "agent" && rev !== refs.current.revision) return; // taken back while rendering
        if (refs.current.tapAt) setM((x) => ({ ...x, tapToAudio: Math.round(performance.now() - refs.current.tapAt) }));
        result = await player().play(buf);
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(4000, text.length * 55)));
      }
    } else {
      await new Promise((r) => setTimeout(r, Math.min(4000, text.length * 55)));
    }
    setSpeaking((s) => (s === turnId ? null : s));
    if (result === "stopped") return;
    send({ type: "desk.agentDone", turnId });
    if (refs.current.auto && refs.current.nextLine < refs.current.total) setTimeout(() => send({ type: "desk.next" }), 900);
  }

  // ---- controls
  const start = () => send({ type: "desk.start", scenarioId });
  const next = () => send({ type: "desk.next" });
  const delegate = () => {
    refs.current.tapAt = performance.now();
    send({ type: "control.delegate", actionId: uid(), revision });
  };
  const pick = (d: Direction) => {
    refs.current.tapAt = performance.now();
    send({ type: "direction.pick", actionId: uid(), revision: d.revision, directionId: d.id });
  };
  const takeBack = () => {
    const wasPlaying = voice.current?.playing ?? false;
    const ms = voice.current?.stop() ?? 0;
    if (wasPlaying) setM((x) => ({ ...x, cuts: x.cuts + 1 }));
    setM((x) => ({ ...x, takeback: ms }));
    send({ type: "control.takeback", actionId: uid(), revision, localSilenceMs: ms, cutTurnId: speaking ?? undefined });
    setSpeaking(null);
  };
  const end = () => {
    voice.current?.stop();
    send({ type: "call.end", actionId: uid(), revision });
  };
  const sayTyped = (speaker: "caller" | "alex") => {
    if (!typed.trim()) return;
    send({ type: "desk.say", speaker, text: typed });
    setTyped("");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && refs.current.floor === "agent") {
        e.preventDefault();
        takeBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- render helpers
  const turnN = (id: string | null | undefined) => (id ? `turn ${id.slice(1)}` : "");
  const who = (t: Turn) => (t.speaker === "alex" ? "Alex" : t.speaker === "agent" ? "ReVoice (AI)" : scenario?.caller ?? "Caller");
  const lvlClass = risk?.level === "High" ? "high" : risk?.level === "Medium" ? "mid" : "low";
  const signList = Object.values(signs).sort((a, b) => Number(a.status === "removed") - Number(b.status === "removed") || b.weight - a.weight);
  const live = floor !== "ended";
  const fs =
    !live ? ["No call", scenario ? "Call ended. Start another scenario." : "Pick a scenario and start the call."]
    : floor === "agent" ? [speaking ? "ReVoice is speaking" : "ReVoice has the floor", "Esc or Take back stops it instantly"]
    : ["You have the floor", "ReVoice is listening, scoring and suggesting"];

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Brain test desk</h1>
          <p className="hint" style={{ margin: 0 }}>Scripted calls stand in for Twilio. Every caller line fans out to the rules, Flash-Lite, Hydrogen risk and notes, Argon planner and Neon supervisor. Carbon reviews the call after hang-up.</p>
        </div>
        <div className="ctl">
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.kind}</option>)}
          </select>
          <button className="btn primary" onClick={start} disabled={ws !== "open"}>{live ? "Restart call" : "Start call"}</button>
          <button className="btn soft" onClick={next} disabled={!live || nextLine >= script.length}>
            Next caller line {script.length ? `(${nextLine}/${script.length})` : ""}
          </button>
          <label className="tog"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto after agent</label>
          <label className="tog"><input type="checkbox" checked={voiceOn} onChange={(e) => { setVoiceOn(e.target.checked); if (!e.target.checked) voice.current?.stop(); }} /> Voices</label>
        </div>
      </div>

      <div className="floor">
        <div className="pills">
          {(["alex", "caller", "agent"] as const).map((k) => (
            <span key={k} className={`pill${(k === "agent" && floor === "agent") || (k === "alex" && floor === "alex") ? " on" : ""}${k === "agent" && speaking ? " ai" : ""}`}>
              <i />{k === "alex" ? "Alex" : k === "caller" ? scenario?.caller ?? "Caller" : "ReVoice"}
            </span>
          ))}
        </div>
        <div className="fstate"><b>{fs[0]}</b><small>{fs[1]}</small></div>
        {floor === "agent"
          ? <button className="btn take" onClick={takeBack}>Take back <span className="kbd">Esc</span></button>
          : <button className="btn primary" onClick={delegate} disabled={!live}>Agent take over</button>}
        <button className="btn ghost" onClick={end} disabled={!live}>End call</button>
      </div>

      <div className="hud">
        <span>Server <b>{ws}</b></span>
        {(Object.keys(LANE_NAMES) as (keyof typeof LANE_NAMES)[]).map((l) => (
          <span key={l} title={lanes[l]?.note}>
            {LANE_NAMES[l]}{" "}
            <b style={{ color: lanes[l] && !lanes[l]!.ok ? "var(--bad)" : undefined }}>{lanes[l] ? `${lanes[l]!.ms} ms` : "–"}</b>
          </span>
        ))}
        <span>Taps accepted <b>{m.accepted}</b></span>
        <span>Rejected <b>{m.rejected}</b></span>
        <span>Cut-offs <b>{m.cuts}</b></span>
        <span>Tap → audio <b>{m.tapToAudio == null ? "–" : `${m.tapToAudio} ms`}</b></span>
        <span className="good">Takeback (local) <b>{m.takeback == null ? "–" : `${m.takeback} ms`}</b></span>
      </div>

      <div className="grid3">
        <div>
          <section className="card">
            <div className="ch"><h2>Guide the agent</h2><span className="tag">Only you</span></div>
            {!live && <p className="hint">Start a call to see suggestions.</p>}
            {live && floor === "alex" && dirs.length > 0 && <p className="hint">Tap Agent take over, then a suggestion. Nothing is said until you tap.</p>}
            {live && floor === "agent" && speaking && <p className="hint">ReVoice is asking your question…</p>}
            {live && dirs.length === 0 && !speaking && <p className="hint">Listening… suggestions update after each caller line.</p>}
            <div className="dirs">
              {dirs.map((d) => (
                <button key={d.id} className="dir" onClick={() => pick(d)} disabled={floor !== "agent" || !!speaking}>
                  <span className="l">{d.label}{d.suggested && <span className="rec">Suggested</span>}<span className={`src ${d.source}`}>{d.source === "planner" ? "Argon" : d.source === "flash" ? "Flash-Lite" : "instant"}</span></span>
                  <span className="say">Will say: “{d.say}”</span>
                  <span className="why">Why: {d.why} {d.whyTurnId && <em>· {turnN(d.whyTurnId)}</em>}</span>
                </button>
              ))}
            </div>
            {withdrawn.length > 0 && (
              <div className="withdrawn">
                {withdrawn.map((w, i) => <div key={i}>Withdrawn: <s>{w.label}</s>, {w.reason} {w.turnId && `· ${turnN(w.turnId)}`}</div>)}
              </div>
            )}
          </section>

          <section className="card">
            <div className="ch"><h2>Conversation</h2><span className="tag">Captions</span></div>
            <div className="log">
              {turns.map((t) => (
                <div key={t.turnId} className={`turn ${t.speaker}${t.status === "cut" ? " cut" : ""}`}>
                  <div className="who">{who(t)} <em>turn {t.n}</em>
                    {speaking === t.turnId && <span className="st speaking">speaking</span>}
                    {t.status === "cut" && <span className="st cut">cut off by you</span>}
                  </div>
                  <p>{t.text}</p>
                </div>
              ))}
              {nextLine < script.length && live && <div className="turn upcoming"><div className="who">Next scripted line</div><p>{script[nextLine]}</p></div>}
            </div>
            <div className="free">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a line live…" disabled={!live}
                onKeyDown={(e) => e.key === "Enter" && sayTyped("caller")} />
              <button className="chip" onClick={() => sayTyped("caller")} disabled={!live}>As caller</button>
              <button className="chip" onClick={() => sayTyped("alex")} disabled={!live || floor === "agent"}>As Alex</button>
            </div>
          </section>
        </div>

        <div>
          <section className="card">
            <div className="ch"><h2>Risk</h2><span className="tag">Weights in code</span></div>
            <div className="risk">
              <span className={`lvl ${lvlClass}`}>{risk?.locked ? "High risk: confirmed" : risk?.level ?? "Low"}</span>
              <span className="hint" style={{ margin: 0 }}>score {risk?.score ?? 0}{risk?.provisional ? " · provisional" : ""}</span>
            </div>
            {signList.length === 0 && <p className="hint">No warning signs so far.</p>}
            {signList.map((s) => (
              <div key={s.id} className={`sig ${s.status}`}>
                <b>{s.weight > 0 ? "+" : ""}{s.weight}</b>
                <span>{s.label} <em>· {turnN(s.evidenceTurnId)}</em></span>
                <span className={`chipst ${s.status}`}>{s.status === "confirmed" ? "Neon ✓" : s.status === "removed" ? "removed" : s.source === "rules" ? "instant" : "Hydrogen"}</span>
              </div>
            ))}
            {scenario && <p className="hint" style={{ marginTop: 8 }}>Expected: {scenario.expected.level} · {scenario.expected.verdict}</p>}
          </section>

          <section className="card">
            <div className="ch"><h2>Notes</h2><span className="tag">Each fact cites a turn</span></div>
            {decision && (
              <div className="decision"><small>Open decision · only you decide</small><b>{decision.text}</b><span className="hint">raised {turnN(decision.evidenceTurnId)}</span></div>
            )}
            {Object.keys(notes).length === 0 && <p className="hint">Neon fills these in a few seconds after each caller line.</p>}
            {Object.entries(notes).map(([f, n]) => (
              <div key={f} className="note">
                <small>{f}</small>
                <strong>{n.value}</strong> <em className="ev">{turnN(n.turnId)}</em>
                {n.history.map((h, i) => <span key={i} className="was">was <s>{h.value}</s> · {turnN(h.turnId)}</span>)}
              </div>
            ))}
          </section>
        </div>
      </div>

      {review && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="ch"><h2>Call review</h2><span className="tag">{review.model} · {review.ms} ms</span></div>
          <p><b>{review.verdict}</b> · {review.finalLevel}{review.locked ? " (locked)" : ""}. {review.summary}</p>
          {review.followUps.map((f, i) => <div key={i} className="note">Follow-up: <strong>{f.action}</strong> <span className="was">{f.why}</span></div>)}
          {review.evals.map((e, i) => <div key={i} className="hint" style={{ margin: 0 }}>{e.pass ? "✓" : "✗"} {e.name}: {e.detail}</div>)}
        </section>
      )}

      <details style={{ marginTop: 14 }}>
        <summary className="hint">Event stream ({events.length})</summary>
        <pre className="events">{events.join("\n")}</pre>
      </details>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
