import { useEffect, useRef, useState } from "react";
import type {
  CallReview, DeskClientMsg, DeskServerMsg, Direction, Floor, Lane, RiskLevel, ScenarioInfo, Sign, Turn,
} from "../../../shared/brain.ts";
import type { CriticReport, JudgeMetrics, Label } from "../../../shared/learn.ts";
import { VoicePlayer } from "../lib/voice.ts";

const AGENT_VOICE = "Sulafat"; // warmest and calmest in scripts/check-tone.ts
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
  const [liveCaller, setLiveCaller] = useState(true);
  const [autoAt, setAutoAt] = useState<number | null>(null); // when the agent will speak its best line on its own
  const [now, setNow] = useState(Date.now());
  const [typed, setTyped] = useState("");
  const [review, setReview] = useState<CallReview | null>(null);
  const [critic, setCritic] = useState<{ report: CriticReport; metrics: JudgeMetrics; label: Label } | null>(null);
  const [playbook, setPlaybook] = useState<Extract<DeskServerMsg, { type: "playbook.updated" }> | null>(null);
  // Risk as it stood after each caller line, for the ticks on the conversation line.
  const [turnRisk, setTurnRisk] = useState<Record<string, { level: RiskLevel["level"]; score: number; locked: boolean }>>({});
  const lastCaller = useRef<string | null>(null);
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
        setTurns([]); setSigns({}); setRisk(null); setNotes({}); setDecision(null); setDirs([]); setWithdrawn([]); setLanes({}); setReview(null); setCritic(null); setPlaybook(null); setTurnRisk({}); lastCaller.current = null;
        setM({ accepted: 0, rejected: 0, cuts: 0, tapToAudio: null, takeback: null });
        if (refs.current.voiceOn) msg.script.forEach((l) => void player().clip(l, CALLER_VOICE).catch(() => {}));
        void player().clip("Hi, this is Alex's AI assistant. Alex is listening in.", AGENT_VOICE).catch(() => {});
        break;
      case "state":
        setFloor(msg.floor); setRevision(msg.revision); setNextLine(msg.nextLine);
        break;
      case "turn.final":
        setTurns((t) => [...t, msg.turn]);
        if (msg.turn.speaker === "caller") lastCaller.current = msg.turn.turnId;
        if (msg.turn.speaker === "caller") {
          // Tell the server when the caller's line has been heard; the auto-speak clock starts there.
          const done = () => send({ type: "desk.callerDone", turnId: msg.turn.turnId });
          const wait = () => new Promise((r) => setTimeout(r, Math.min(4000, msg.turn.text.length * 55)));
          if (refs.current.voiceOn) void player().clip(msg.turn.text, CALLER_VOICE).then((b) => player().play(b)).catch(wait).then(done);
          else void wait().then(done);
        }
        break;
      case "agent.autoPick":
        setAutoAt(msg.directionId === null && msg.inMs === 0 ? null : Date.now() + msg.inMs);
        break;
      case "agent.say":
        setAutoAt(null);
        if (msg.auto) flash("No tap in time: ReVoice said its most confident line");
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
        if (lastCaller.current) {
          const id = lastCaller.current;
          setTurnRisk((r) => ({ ...r, [id]: { level: msg.risk.level, score: msg.risk.score, locked: msg.risk.locked } }));
        }
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
      case "critic.report":
        setCritic({ report: msg.report, metrics: msg.metrics, label: msg.label });
        break;
      case "playbook.updated":
        setPlaybook(msg);
        break;
      case "call.ended":
        player().stop();
        setDirs([]); setWithdrawn([]); setAutoAt(null);
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

  useEffect(() => {
    if (!autoAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [autoAt]);

  // ---- controls
  const start = () => send({ type: "desk.start", scenarioId, mode: liveCaller ? "live" : "script" });
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
  const turnN = (id: string | null | undefined) => (id ? `line ${id.slice(1)}` : "");
  const who = (t: Turn) => (t.speaker === "alex" ? "You" : t.speaker === "agent" ? "Your AI assistant" : scenario?.caller ?? "Caller");
  const lvlClass = (l?: RiskLevel["level"]) => (l === "High" ? "high" : l === "Medium" ? "mid" : "low");
  const signList = Object.values(signs).sort((a, b) => Number(a.status === "removed") - Number(b.status === "removed") || b.weight - a.weight);
  const live = floor !== "ended";
  const secondsLeft = autoAt ? Math.max(0, Math.ceil((autoAt - now) / 1000)) : 0;
  const AUTO_MS = 4000;
  const fs =
    !live ? [scenario ? "Call ended" : "No call yet", scenario ? "Read the report below, or start another call." : "Pick a caller and start the call."]
    : floor === "agent" ? [speaking ? "Your assistant is speaking" : autoAt ? `Your assistant speaks in ${secondsLeft}s` : "Your assistant has the call", autoAt && !speaking ? "Tap a suggestion to choose its next line yourself" : "Press Esc or Take back to stop it at once"]
    : ["You have the call", "Your assistant is listening, scoring the risk and suggesting what to ask"];
  // Score → position on the Low / Medium / High track (High starts at 8; clamp at 14 so the marker stays on the bar).
  const markPos = Math.max(2, Math.min(98, ((Math.max(0, risk?.score ?? 0) + 0.5) / 12) * 100));
  const LANE_LABEL: Record<Exclude<Lane, "review">, string> = { rules: "Instant rules", flash: "Quick suggestions", risk: "Risk check", notes: "Notes", planner: "Planner", supervisor: "Supervisor" };
  const GRADE: Record<"classification" | "questioning" | "timing" | "safety", string> = { classification: "Right call", questioning: "Questions", timing: "Timing", safety: "Safety" };

  return (
    <div className="wrap">
      <div className="deskhead">
        <div>
          <h1>Call desk</h1>
          <p>Gemini plays the caller. Hand the call to your assistant, steer what it asks, and see how risky the call is after every line.</p>
        </div>
        <div className="setup">
          <select className="select" aria-label="Caller" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title.replace(/\s*\([^)]*demo\)/i, "")}{s.kind === "scam" ? " (scam)" : s.kind === "legit" ? " (real)" : " (everyday)"}</option>)}
          </select>
          <label className="toggle"><input type="checkbox" checked={liveCaller} onChange={(e) => setLiveCaller(e.target.checked)} /> Live caller</label>
          <label className="toggle"><input type="checkbox" checked={voiceOn} onChange={(e) => { setVoiceOn(e.target.checked); if (!e.target.checked) voice.current?.stop(); }} /> Voices</label>
          {!liveCaller && live && <>
            <button className="btn soft" onClick={next} disabled={nextLine >= script.length}>
              Next caller line <span className="num">{nextLine}/{script.length}</span>
            </button>
            <label className="toggle"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-advance</label>
          </>}
          <button className="btn primary" onClick={start} disabled={ws !== "open"}>{live ? "Restart call" : "Start call"}</button>
        </div>
      </div>

      <div className={`floor ${floor === "agent" ? "agent" : !live && scenario ? "ended" : ""}`} role="status" aria-live="polite">
        <div className="seats" aria-hidden="true">
          <span className={`seat${floor === "alex" ? " on" : ""}`}><i />You</span>
          <span className={`seat${floor === "agent" ? " on ai" : ""}`}><i />Assistant</span>
          <span className="seat"><i />{scenario?.caller ?? "Caller"}</span>
        </div>
        <div className="fstate"><b>{fs[0]}</b><small>{fs[1]}</small></div>
        {floor === "agent"
          ? <button className="btn take" onClick={takeBack}>Take back <span className="kbd">Esc</span></button>
          : <button className="btn agent" onClick={delegate} disabled={!live}>Hand to assistant</button>}
        <button className="btn ghost" onClick={end} disabled={!live}>End call</button>
      </div>

      <div className="desk">
        <div>
          <section className="panel">
            <div className="panel-h"><h2>What to ask next</h2><span className="aside">Only you see this</span></div>
            {floor === "agent" && autoAt && !speaking && (
              <div className="countdown" aria-hidden="true"><div style={{ width: `${Math.min(100, (secondsLeft * 1000 / AUTO_MS) * 100)}%` }} /></div>
            )}
            {!live && <p className="hint">{scenario ? "The call has ended." : "Start a call. Suggestions appear after the caller's first line."}</p>}
            {live && floor === "alex" && dirs.length > 0 && <p className="hint" style={{ marginBottom: 12 }}>Hand the call to your assistant to use these.</p>}
            {live && floor === "agent" && speaking && <p className="hint" style={{ marginBottom: 12 }}>Your assistant is asking now.</p>}
            {live && dirs.length === 0 && !speaking && <p className="hint">Listening. New suggestions come after each caller line.</p>}
            <div className="dirs">
              {dirs.map((d) => (
                <button key={d.id} className={`dir${d.suggested ? " suggested" : ""}`} onClick={() => pick(d)} disabled={floor !== "agent" || !!speaking}>
                  <span className="l">{d.label}{d.suggested && <span className="rec">Best next step</span>}<span className="src">{d.source === "planner" ? "Planned" : d.source === "flash" ? "Quick" : "Instant"}</span></span>
                  <span className="say">“{d.say}”</span>
                  <span className="why">{d.why}{d.whyTurnId && `, ${turnN(d.whyTurnId)}`}</span>
                </button>
              ))}
            </div>
            {withdrawn.length > 0 && (
              <div className="withdrawn">
                {withdrawn.map((w, i) => <div key={i}><s>{w.label}</s>: {w.reason}{w.turnId && `, ${turnN(w.turnId)}`}</div>)}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-h"><h2>Conversation</h2><span className="aside">Risk after each caller line</span></div>
            {turns.length === 0 && <p className="hint">The transcript appears here as people speak.</p>}
            <div className="line">
              {turns.map((t) => {
                const tr = t.speaker === "caller" ? turnRisk[t.turnId] : undefined;
                return (
                  <div key={t.turnId} className={`turn ${t.speaker}${t.status === "cut" ? " cut" : ""}`}>
                    <span className="dot" aria-hidden="true" />
                    <div>
                      <div className="who">{who(t)} <em>line {t.n}</em>
                        {speaking === t.turnId && <span className="st speaking">speaking</span>}
                        {t.status === "cut" && <span className="st cut">cut off by you</span>}
                      </div>
                      <p>{t.text}</p>
                    </div>
                    {tr ? <span className={`tick ${lvlClass(tr.level)} num`} title={`Risk after this line: ${tr.level}, score ${tr.score}`}>{tr.locked ? "Confirmed" : tr.level} {tr.score}</span> : <span />}
                  </div>
                );
              })}
              {!liveCaller && nextLine < script.length && live && (
                <div className="turn upcoming"><span className="dot" aria-hidden="true" /><div><div className="who">Next scripted line</div><p>{script[nextLine]}</p></div><span /></div>
              )}
            </div>
            <div className="free">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a line…" aria-label="Type a line" disabled={!live}
                onKeyDown={(e) => e.key === "Enter" && sayTyped("caller")} />
              <button className="chip" onClick={() => sayTyped("caller")} disabled={!live}>Say as caller</button>
              <button className="chip" onClick={() => sayTyped("alex")} disabled={!live || floor === "agent"}>Say as you</button>
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-h"><h2>Risk</h2>{risk?.provisional && <span className="aside">Some signs still being checked</span>}</div>
            <div className="risk-now">
              <span className={`lvl ${lvlClass(risk?.level)}`}>{risk?.level ?? "Low"}</span>
              <span className="score num">score {risk?.score ?? 0}</span>
              {risk?.locked && <span className="locked">Confirmed scam pattern</span>}
            </div>
            <div className="track" role="img" aria-label={`Risk score ${risk?.score ?? 0}`}><span className="mark" style={{ left: `${markPos}%` }} /></div>
            <div className="track-labels"><span>Low</span><span>Medium</span><span>High</span></div>
            <div className="signs">
              {signList.length === 0 && <p className="hint" style={{ marginTop: 4 }}>No warning signs so far.</p>}
              {signList.map((s) => (
                <div key={s.id} className={`sig ${s.status}`}>
                  <b>{s.weight > 0 ? "+" : ""}{s.weight}</b>
                  <span>{s.label} <em>{turnN(s.evidenceTurnId)}</em></span>
                  <span className={`chipst ${s.status}`}>{s.status === "confirmed" ? "Confirmed" : s.status === "removed" ? "Ruled out" : "Checking"}</span>
                </div>
              ))}
            </div>
            {scenario && <p className="expected">Expected result: {scenario.expected.level} risk ({scenario.expected.verdict.replace(/^\w+:\s*/, "").toLowerCase()})</p>}
          </section>

          <section className="panel">
            <div className="panel-h"><h2>Notes</h2><span className="aside">Each fact links to its line</span></div>
            {decision && (
              <div className="decision"><small>Only you decide</small><b>{decision.text}</b><span className="hint">Raised on {turnN(decision.evidenceTurnId)}</span></div>
            )}
            {Object.keys(notes).length === 0 && <p className="hint">Who they say they are, what they want, how and by when. Filled in as the caller speaks.</p>}
            <div className="notes">
              {Object.entries(notes).map(([f, n]) => (
                <div key={f} className="note">
                  <small>{f}</small>
                  <span>
                    <strong>{n.value}</strong><em className="ev">{turnN(n.turnId)}</em>
                    {n.history.map((h, i) => <span key={i} className="was">was <s>{h.value}</s>, {turnN(h.turnId)}</span>)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {review && (
        <article className="report" aria-label="Call report">
          <header className="report-head">
            <div>
              <h2>After the call</h2>
              <p>{review.summary}</p>
            </div>
            <span className={`verdict ${review.verdict}`}>{review.verdict === "scam" ? "Scam" : review.verdict === "legit" ? "Legitimate" : "Unclear"}</span>
          </header>
          <div className="report-body">
            <section>
              <h3>Next steps for you</h3>
              {review.followUps.length === 0 && <p className="hint">Nothing to follow up.</p>}
              {review.followUps.map((f, i) => <div key={i} className="follow">{f.action}<span>{f.why}</span></div>)}
              <div className="checks">
                {review.evals.map((e, i) => <div key={i} className={e.pass ? "pass" : "fail"}>{e.name}: {e.detail}</div>)}
              </div>
            </section>
            <section>
              <h3>How the assistant did</h3>
              <div className="ask">
                Was this a scam?
                {(["scam", "legit", "unknown"] as Label[]).map((l) => (
                  <button key={l} className={`chip${critic?.label === l ? " on" : ""}`} onClick={() => { setCritic(null); send({ type: "call.label", label: l }); }}>
                    {l === "scam" ? "Yes" : l === "legit" ? "No" : "Not sure"}
                  </button>
                ))}
              </div>
              {!critic && <span className="pending">The critic is reviewing the call</span>}
              {critic && (
                <>
                  <div className="grades">
                    {(Object.keys(GRADE) as (keyof typeof GRADE)[]).map((g) => (
                      <div key={g} className="grade"><small>{GRADE[g]}</small><b className="num">{critic.report.grades[g]}<span>/5</span></b></div>
                    ))}
                  </div>
                  <p style={{ marginBottom: 10 }}>{critic.report.summary}</p>
                  <p className="judge">
                    {critic.metrics.verdictCorrect === null ? "No label yet." : critic.metrics.verdictCorrect ? "Right verdict." : "Wrong verdict."}
                    {" "}Reached High {critic.metrics.reachedHighAt ? `on caller line ${critic.metrics.reachedHighAt}` : "never"};
                    {" "}first identity check {critic.metrics.firstCheckAskedAt ? `after caller line ${critic.metrics.firstCheckAskedAt}` : "never asked"};
                    {" "}money came up {critic.metrics.firstMoneyAt ? `on caller line ${critic.metrics.firstMoneyAt}` : "never"}.
                    {critic.metrics.repeatedCategories.length ? ` Repeated: ${critic.metrics.repeatedCategories.join(", ").replace(/_/g, " ")}.` : ""}
                  </p>
                  {critic.report.findings.map((f, i) => (
                    <div key={i} className="finding">
                      <small className={f.severity >= 3 ? "serious" : ""}>{f.type.replace(/_/g, " ")}, {f.turns.map(turnN).join(", ")}</small>
                      <span>{f.whatHappened}</span>
                      {f.shouldHave && <span className="better">Better: {f.shouldHave}</span>}
                    </div>
                  ))}
                  {critic.report.proposed.map((l, i) => (
                    <div key={i} className="lesson"><small>Lesson for next time</small>When {l.when.replace(/\.$/, "")}: {l.do}</div>
                  ))}
                  {critic.report.rejected.map((r, i) => <div key={i} className="refused">Refused lesson: {r}</div>)}
                </>
              )}
            </section>
          </div>
          {playbook && (
            <div className="pbook">
              Playbook updated from v{playbook.update.fromVersion} to v{playbook.version}
              {playbook.update.added.length ? `, added ${playbook.update.added.join(", ")}` : ""}
              {playbook.update.reinforced.length ? `, reinforced ${[...new Set(playbook.update.reinforced)].join(", ")}` : ""}
              {playbook.update.promoted.length ? `, promoted ${playbook.update.promoted.join(", ")}` : ""}.
              {" "}{playbook.active.length} active lessons apply from the next call.
            </div>
          )}
        </article>
      )}

      <details className="diag">
        <summary>Diagnostics</summary>
        <div className="hud">
          <span>Server <b>{ws}</b></span>
          {(Object.keys(LANE_LABEL) as (keyof typeof LANE_LABEL)[]).map((l) => (
            <span key={l} title={lanes[l]?.note}>{LANE_LABEL[l]} ({LANE_NAMES[l]}) <b className={lanes[l] && !lanes[l]!.ok ? "bad" : ""}>{lanes[l] ? `${lanes[l]!.ms} ms` : "–"}</b></span>
          ))}
          <span>Taps accepted <b>{m.accepted}</b></span>
          <span>Taps rejected <b>{m.rejected}</b></span>
          <span>Cut-offs <b>{m.cuts}</b></span>
          <span>Tap to audio <b>{m.tapToAudio == null ? "–" : `${m.tapToAudio} ms`}</b></span>
          <span>Take back silence <b>{m.takeback == null ? "–" : `${m.takeback} ms`}</b></span>
        </div>
        <pre className="events">{events.join("\n")}</pre>
      </details>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
