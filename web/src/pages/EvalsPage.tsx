import { useEffect, useMemo, useRef, useState } from "react";
import type { SuiteCall, SuiteRun } from "../../../shared/learn.ts";

interface Persona { id: string; title: string; kind: "scam" | "legit" }

const fmtDate = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const PART_LABEL: Record<keyof SuiteCall["parts"], [string, number]> = {
  verdict: ["Right verdict", 30], detection: ["Caught early", 20], checkTiming: ["Check before money", 15], critic: ["Critic's grades", 25], safety: ["Safety", 10],
};

/** Score per call: one line for the selected run, earlier runs in quiet grey for context. */
function ScoreChart({ run, others }: { run: SuiteRun; others: SuiteRun[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(run.calls.length, ...others.map((o) => o.calls.length), 2);
  const W = 1100, H = 300, L = 40, R = 24, T = 28, B = 36;
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (s: number) => T + ((100 - s) * (H - T - B)) / 100;
  const path = (calls: SuiteCall[]) => calls.map((c, i) => `${i ? "L" : "M"}${x(i)},${y(c.score)}`).join(" ");
  const h = hover !== null ? run.calls[hover] : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score per call: ${run.calls.map((c) => c.score).join(", ")}`} onMouseLeave={() => setHover(null)}>
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="grid" />
            <text x={L - 10} y={y(g) + 4} className="tick-l" textAnchor="end">{g}</text>
          </g>
        ))}
        {Array.from({ length: n }, (_, i) => <text key={i} x={x(i)} y={H - 14} className="tick-l" textAnchor="middle">Call {i + 1}</text>)}
        {others.map((o) => <path key={o.name} d={path(o.calls)} className="line other" />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="cross" />}
        <path d={path(run.calls)} className="line main" />
        {run.calls.map((c, i) => (
          <g key={c.n}>
            <circle cx={x(i)} cy={y(c.score)} r={hover === i ? 7 : 5} className="pt" />
            <text x={x(i)} y={y(c.score) - 14} textAnchor="middle" className="pt-l">{c.score}</text>
            <rect x={x(i) - (W - L - R) / (2 * (n - 1))} y={T} width={(W - L - R) / (n - 1)} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />
          </g>
        ))}
      </svg>
      {h && (
        <div className="tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <b>Call {h.n}: {h.score}/100</b>{h.delta !== null && <span> ({h.delta >= 0 ? "+" : ""}{h.delta})</span>}
          {(Object.keys(PART_LABEL) as (keyof SuiteCall["parts"])[]).map((k) => <div key={k}>{PART_LABEL[k][0]} <span className="num">{h.parts[k]}/{PART_LABEL[k][1]}</span></div>)}
        </div>
      )}
      {others.length > 0 && (
        <div className="legend"><span><i className="sw main" />This run</span><span><i className="sw other" />Earlier runs</span></div>
      )}
    </div>
  );
}

export function EvalsPage() {
  const [runs, setRuns] = useState<SuiteRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState("sister-tow");
  const [calls, setCalls] = useState(5);
  const [startFrom, setStartFrom] = useState<"empty" | "current">("empty");
  const [job, setJob] = useState<{ id: string; log: string; done: boolean } | null>(null);
  const poll = useRef<number | null>(null);

  const load = () =>
    fetch("/api/evals").then((r) => r.json()).then((d: { name: string; data: SuiteRun }[]) => {
      setRuns(d.map((x) => x.data).filter((x) => x?.kind === "suite"));
      setError(null);
    }).catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
    fetch("/api/personas").then((r) => r.json()).then(setPersonas).catch(() => {});
    return () => { if (poll.current) clearInterval(poll.current); };
  }, []);

  const start = async () => {
    const r = await fetch("/api/evals/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls, persona, current: startFrom === "current" }) });
    const d = await r.json();
    if (!d.id) return setError(d.error ?? "Couldn't start the suite");
    setJob({ id: d.id, log: "", done: false });
    setSel(null);
    if (poll.current) clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const s = await fetch(`/api/dev/runs/${d.id}`).then((x) => x.json()).catch(() => null);
      if (s) setJob({ id: d.id, log: s.tail, done: s.done });
      void load();
      if (s?.done && poll.current) { clearInterval(poll.current); poll.current = null; }
    }, 4000);
  };

  const run = useMemo(() => runs?.find((r) => r.name === sel) ?? runs?.[0] ?? null, [runs, sel]);
  const others = useMemo(() => (runs ?? []).filter((r) => r !== run && r.calls.length > 1 && r.persona.join() === run?.persona.join()).slice(0, 4), [runs, run]);
  const agreed = run ? run.calls.filter((c) => c.criticAgreesWithTruth).length : 0;

  return (
    <div className="wrap">
      <div className="deskhead">
        <div>
          <h1>Evals</h1>
          <p>Five calls in a row with the same caller. Each call starts with the lessons the critic wrote after the call before it. Every score is computed in code from what happened on the call, so a better number means the agent actually did better.</p>
        </div>
        <div className="setup">
          <select className="select" aria-label="Caller" value={persona} onChange={(e) => setPersona(e.target.value)} style={{ minWidth: 200 }}>
            {(personas.length ? personas : [{ id: "sister-tow", title: "Fake sister, car accident", kind: "scam" as const }]).map((p) => <option key={p.id} value={p.id}>{p.title} ({p.kind === "scam" ? "scam" : "real"})</option>)}
          </select>
          <select className="select" aria-label="Number of calls" value={calls} onChange={(e) => setCalls(Number(e.target.value))} style={{ minWidth: 0 }}>
            {[3, 5, 7].map((c) => <option key={c} value={c}>{c} calls</option>)}
          </select>
          <select className="select" aria-label="Start from" value={startFrom} onChange={(e) => setStartFrom(e.target.value as "empty" | "current")} style={{ minWidth: 0 }}>
            <option value="empty">From no lessons</option>
            <option value="current">From current lessons</option>
          </select>
          <button className="btn primary" onClick={start} disabled={!!job && !job.done}>{job && !job.done ? "Running…" : "Run suite"}</button>
        </div>
      </div>

      {job && !job.done && (
        <section className="panel running">
          <span className="pending">Running the suite. Each call takes about a minute and a half with the critic; results appear below as each call finishes.</span>
          <pre className="joblog">{job.log.split("\n").filter(Boolean).slice(-6).join("\n") || "Starting…"}</pre>
        </section>
      )}
      {error && <p className="alert bad" style={{ marginBottom: 16 }}>Couldn't load the evals: {error}</p>}
      {runs && runs.length === 0 && !job && (
        <section className="panel empty"><h2>No suite runs yet</h2><p className="hint">Pick a caller and press Run suite. The first call starts with no lessons; watch the score climb as the critic teaches each next call.</p></section>
      )}

      {run && (
        <>
          <div className="tiles">
            <div className="tile"><small>Score, first call to last</small><b className="num">{run.calls[0]?.score ?? "–"} → {run.calls.at(-1)?.score ?? "–"}</b><span>{run.result ? `best ${run.result.best}` : `${run.calls.length} of ${run.calls.length} done so far`}</span></div>
            <div className="tile"><small>Calls that beat the one before</small><b className="num">{run.calls.filter((c) => c.trend === "better").length} of {Math.max(0, run.calls.length - 1)}</b><span>{run.calls.filter((c) => c.trend === "worse").length} dropped</span></div>
            <div className={`tile ${run.result ? (run.result.passed ? "ok" : "bad") : ""}`}>
              <small>Result</small>
              <b>{run.status === "running" ? "Running" : run.status === "failed" ? "Failed" : run.result?.passed ? "✓ Improved every call" : "✗ Not every call improved"}</b>
              <span>{run.status === "failed" ? run.error : "Pass = ends higher than it started and never drops by more than 2 points"}</span>
            </div>
            <div className="tile"><small>Critic's own verdict was right</small><b className="num">{agreed} of {run.calls.length}</b><span>decided without being told the answer</span></div>
          </div>

          <section className="panel">
            <div className="panel-h">
              <h2>Score per call</h2>
              <span className="aside">
                <select className="select small" aria-label="Run" value={run.name} onChange={(e) => setSel(e.target.value)}>
                  {(runs ?? []).map((r) => <option key={r.name} value={r.name}>{fmtDate(r.startedAt)}: {r.persona.join(", ")}{r.status === "running" ? " (running)" : ""}</option>)}
                </select>
              </span>
            </div>
            {run.calls.length ? <ScoreChart run={run} others={others} /> : <p className="hint">The first call is in progress.</p>}
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-h"><h2>Metrics by call</h2><span className="aside">Lines are caller lines; "–" means it never happened</span></div>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr><th>Call</th><th>Lessons at start</th><th>Score</th><th>Change</th><th>Verdict</th><th>Reached High</th><th>First check</th><th>Money asked</th><th>Questions</th><th>Timing</th><th>Critic's own call</th></tr>
                </thead>
                <tbody>
                  {run.calls.map((c) => (
                    <tr key={c.n}>
                      <td>{c.n}</td>
                      <td className="num">{c.playbookLessons}</td>
                      <td className="num"><b>{c.score}</b></td>
                      <td className={`num trend ${c.trend}`}>{c.delta === null ? "–" : `${c.delta > 0 ? "▲ +" : c.delta < 0 ? "▼ " : "= "}${c.delta === 0 ? "0" : c.delta}`}</td>
                      <td>{c.metrics.verdictCorrect ? "✓ right" : "✗ wrong"}</td>
                      <td className="num">{c.metrics.reachedHighAt ? `line ${c.metrics.reachedHighAt}` : "–"}</td>
                      <td className="num">{c.metrics.firstCheckAskedAt ? `after line ${c.metrics.firstCheckAskedAt}` : "–"}</td>
                      <td className="num">{c.metrics.firstMoneyAt ? `line ${c.metrics.firstMoneyAt}` : "–"}</td>
                      <td className="num">{c.grades.questioning}/5</td>
                      <td className="num">{c.grades.timing}/5</td>
                      <td>{c.ownVerdict ? `${c.ownVerdict.call} (${Math.round(c.ownVerdict.confidence * 100)}%)` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ marginBottom: 12 }}>How each call taught the next</h2>
            <ol className="trail">
              {run.calls.map((c) => (
                <li key={c.n} className="panel">
                  <div className="trail-h">
                    <b>Call {c.n}</b>
                    <span className={`num score ${c.trend}`}>{c.score}/100{c.delta !== null ? ` (${c.delta >= 0 ? "+" : ""}${c.delta})` : ""}</span>
                    <a className="more" href={`/reviews?call=${encodeURIComponent(c.callId)}`}>Full review</a>
                  </div>
                  <p>{c.summary || "No critic summary."}</p>
                  {c.caps.length > 0 && <p className="capnote">Capped by the facts: {c.caps.join("; ")}</p>}
                  {c.lessonsAdded.length > 0
                    ? <div className="taught"><small>Taught the next call</small>{c.lessonsAdded.map((l) => <div key={l.id}><b>{l.id}</b> When {l.when.replace(/\.$/, "")}: {l.do}</div>)}</div>
                    : <div className="taught none"><small>No new lesson: nothing new to fix, or it repeated one already learned</small></div>}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      {!runs && !error && <p className="pending">Loading the evals</p>}
    </div>
  );
}
