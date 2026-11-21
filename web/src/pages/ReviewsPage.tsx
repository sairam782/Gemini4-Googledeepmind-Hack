import { useEffect, useMemo, useState } from "react";
import type { CallRecord, CriticReport, JudgeMetrics, Playbook } from "../../../shared/learn.ts";

interface Stored { record: CallRecord; metrics: JudgeMetrics; critic: CriticReport | null }

const fmtDate = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// Readable caller names: personas (eval calls) come from the server; desk scenarios read fine as ids.
const titles: Record<string, string> = {};
const name = (r: CallRecord) => (r.personaId && titles[r.personaId]) || r.personaId || r.scenarioId || r.from;
const source = (r: CallRecord) => (r.source === "sim" ? "Eval call" : r.source === "desk" ? "Call desk" : "Phone call");
const GRADE: Record<keyof CriticReport["grades"], string> = { classification: "Right call", questioning: "Questions", timing: "Timing", safety: "Safety" };

function Review({ c }: { c: Stored }) {
  const { record: r, metrics: m, critic } = c;
  const lineN = (id: string) => `line ${id.slice(1)}`;
  return (
    <article className="panel review">
      <header className="review-h">
        <div>
          <h2>{name(r)}</h2>
          <p className="hint">{source(r)}, {fmtDate(r.endedAt)}, from {r.from}. Started with playbook v{r.playbookVersion}.</p>
        </div>
        {critic?.ownVerdict && (
          <span className={`verdict ${critic.ownVerdict.call}`}>{critic.ownVerdict.call === "scam" ? "Scam" : critic.ownVerdict.call === "legit" ? "Legitimate" : "Unclear"} <small className="num">{Math.round(critic.ownVerdict.confidence * 100)}%</small></span>
        )}
      </header>

      {!critic && <p className="hint">No critic review was stored for this call.</p>}
      {critic && !critic.ok && <p className="alert bad">The critic failed on this call: {critic.error}</p>}
      {critic?.ok && (
        <>
          {critic.ownVerdict && <p className="why"><b>The critic's own call:</b> {critic.ownVerdict.reasons}{critic.ownVerdict.evidence.length ? ` (${critic.ownVerdict.evidence.map(lineN).join(", ")})` : ""}</p>}
          {r.label !== "unknown" && (r.labelSource === "scenario" || r.labelSource === "persona") && (
            <p className="hint" style={{ marginBottom: 12 }}>Known answer for this test call: {r.label}. The critic {critic.ownVerdict?.call === r.label ? "got it right" : "got it wrong"} without being told.</p>
          )}
          {critic.alexOpinion && <p className="hint">Your answer: {critic.alexOpinion.label === "scam" ? "a scam" : "legitimate"}. The critic {critic.alexOpinion.agrees ? "agrees" : "disagrees"}: {critic.alexOpinion.note}</p>}
          <div className="grades">
            {(Object.keys(GRADE) as (keyof typeof GRADE)[]).map((g) => (
              <div key={g} className="grade">
                <small>{GRADE[g]}</small>
                <b className="num">{critic.grades[g]}<span>/5</span></b>
                {critic.rawGrades && critic.rawGrades[g] !== critic.grades[g] && <em className="capped">model said {critic.rawGrades[g]}</em>}
              </div>
            ))}
          </div>
          {critic.caps && critic.caps.length > 0 && <p className="capnote">Capped by the facts: {critic.caps.join("; ")}</p>}
          <p>{critic.summary}</p>
          <p className="judge">
            Code judge: meter ended {m.finalLevel}{m.locked ? " (locked)" : ""}, reached High {m.reachedHighAt ? `on caller line ${m.reachedHighAt}` : "never"};
            first identity check {m.firstCheckAskedAt ? `after caller line ${m.firstCheckAskedAt}` : "never asked"}; money {m.firstMoneyAt ? `on caller line ${m.firstMoneyAt}` : "never asked"}.
          </p>
          {critic.findings.map((f, i) => (
            <div key={i} className="finding">
              <small className={f.severity >= 3 ? "serious" : ""}>{f.type.replace(/_/g, " ")}, {f.turns.map(lineN).join(", ")}</small>
              <span>{f.whatHappened}</span>
              {f.shouldHave && <span className="better">Better: {f.shouldHave}</span>}
            </div>
          ))}
          {critic.proposed.map((l, i) => <div key={i} className="lesson"><small>Lesson fed back to the agent</small>When {l.when.replace(/\.$/, "")}: {l.do}</div>)}
          {critic.rejected.map((x, i) => <div key={i} className="refused">Refused lesson: {x}</div>)}
        </>
      )}

      <details className="transcript">
        <summary>Transcript ({r.turns.length} lines)</summary>
        <div className="line" style={{ maxHeight: "none" }}>
          {r.turns.map((t) => (
            <div key={t.turnId} className={`turn ${t.speaker}${t.status === "cut" ? " cut" : ""}`}>
              <span className="dot" aria-hidden="true" />
              <div><div className="who">{t.speaker === "agent" ? "Assistant" : t.speaker === "alex" ? "Alex" : "Caller"} <em>line {t.n}</em></div><p>{t.text}</p></div>
              <span />
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

export function ReviewsPage() {
  const [calls, setCalls] = useState<Stored[] | null>(null);
  const [pb, setPb] = useState<Playbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(new URLSearchParams(location.search).get("call"));

  useEffect(() => {
    fetch("/api/personas").then((r) => r.json()).then((ps: { id: string; title: string }[]) => ps.forEach((p) => (titles[p.id] = p.title)))
      .catch(() => {})
      .finally(() => fetch("/api/reviews?limit=60").then((r) => r.json()).then(setCalls).catch((e) => setError(String(e))));
    fetch("/api/playbook").then((r) => r.json()).then(setPb).catch(() => {});
  }, []);

  const current = useMemo(() => calls?.find((c) => c.record.callId === sel) ?? calls?.[0] ?? null, [calls, sel]);
  const active = pb?.lessons.filter((l) => l.status === "active") ?? [];

  return (
    <div className="wrap">
      <div className="deskhead">
        <div>
          <h1>Reviews</h1>
          <p>After every call, a strict critic (Gemini 4 Neon, thinking on high) decides for itself whether it was a scam, grades the assistant, and writes lessons. The lessons go into the playbook the next call starts with.</p>
        </div>
      </div>

      <section className="panel playbook">
        <div className="panel-h"><h2>What the agent uses now</h2><span className="aside">{pb ? `Playbook v${pb.version}, ${active.length} active lessons` : ""}</span></div>
        {active.length === 0 && <p className="hint">No lessons yet. They appear after the first reviewed call.</p>}
        <ul className="lessons">
          {active.map((l) => (
            <li key={l.id}><b>{l.id}</b> When {l.when.replace(/\.$/, "")}: {l.do} <span className="seen">seen {l.seen}×</span></li>
          ))}
        </ul>
      </section>

      {error && <p className="alert bad">Couldn't load the reviews: {error}</p>}
      {calls && calls.length === 0 && <section className="panel empty" style={{ marginTop: 20 }}><h2>No reviewed calls yet</h2><p className="hint">End a call on the call desk, or run the eval suite.</p></section>}
      {calls && calls.length > 0 && (
        <div className="reviews">
          <nav className="calllist" aria-label="Reviewed calls">
            {calls.map((c) => {
              const v = c.critic?.ownVerdict;
              const on = c === current;
              return (
                <button key={c.record.callId} className={`callitem${on ? " on" : ""}`} onClick={() => { setSel(c.record.callId); history.replaceState(null, "", `/reviews?call=${encodeURIComponent(c.record.callId)}`); }}>
                  <span className="ci-top"><b>{name(c.record)}</b>{v && <span className={`dotv ${v.call}`} aria-label={v.call} />}</span>
                  <span className="ci-sub">{source(c.record)}, {fmtDate(c.record.endedAt)}</span>
                  {c.critic?.ok && <span className="ci-sub num">questions {c.critic.grades.questioning}/5, timing {c.critic.grades.timing}/5</span>}
                </button>
              );
            })}
          </nav>
          {current && <Review c={current} />}
        </div>
      )}
      {!calls && !error && <p className="pending">Loading the reviews</p>}
    </div>
  );
}
