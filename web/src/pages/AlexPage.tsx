import { useCallback, useEffect, useRef, useState } from "react";
import type { CallState, ServerMsg } from "../../../shared/protocol.ts";
import { Signaling } from "../lib/signaling.ts";
import { AudioCall } from "../lib/rtc.ts";
import { Mixer } from "../lib/mixer.ts";

const INTRO = "Hi, this is Alex's AI assistant. Alex is listening. Who's calling, and what can I help with?";
const uid = () => crypto.randomUUID();

interface Counters {
  accepted: number;
  duplicate: number;
  stale: number;
  discarded: number;
  cuts: number;
  late: number;
  tapToFirstAudio: number | null;
  localSilence: number | null;
  remoteSilence: number | null;
}
const ZERO: Counters = {
  accepted: 0, duplicate: 0, stale: 0, discarded: 0, cuts: 0, late: 0,
  tapToFirstAudio: null, localSilence: null, remoteSilence: null,
};

export function AlexPage({ callId }: { callId: string }) {
  const [joined, setJoined] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ws, setWs] = useState<"connecting" | "open" | "closed">("connecting");
  const [rtc, setRtc] = useState<string>("idle");
  const [state, setState] = useState<CallState | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [m, setM] = useState<Counters>(ZERO);
  const [say, setSay] = useState(INTRO);
  const [clipStatus, setClipStatus] = useState<string>("");
  const [tts, setTts] = useState<boolean | null>(null);

  const sig = useRef<Signaling | null>(null);
  const mixer = useRef<Mixer | null>(null);
  const call = useRef<AudioCall | null>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const rev = useRef(0);
  const floor = useRef<CallState["floor"]>("alex");
  const clips = useRef(new Map<string, Promise<AudioBuffer>>());

  const log = useCallback((line: string) => {
    setEvents((e) => [...e.slice(-60), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);
  const bump = useCallback((k: keyof Counters, v?: number) => {
    setM((c) => ({ ...c, [k]: v ?? ((c[k] as number) ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setTts(!!h.tts)).catch(() => setTts(false));
  }, []);

  async function join() {
    try {
      const mx = await Mixer.create();
      mixer.current = mx;
      mx.onClipEnd = () => setClipStatus("Clip finished");
      const s = new Signaling("alex", callId);
      sig.current = s;
      s.onStatus = setWs;
      s.on(onServer);
      const c = new AudioCall(s, mx.outgoing, true);
      c.onRemoteStream = (stream) => {
        if (remoteAudio.current) remoteAudio.current.srcObject = stream;
      };
      c.onState = setRtc;
      call.current = c;
      setJoined(true);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
  }

  function onServer(msg: ServerMsg) {
    if (msg.type === "signal") log(`signal ${msg.data.kind}`);
    else if (msg.type !== "pong") log(JSON.stringify(msg).slice(0, 180));
    switch (msg.type) {
      case "joined":
      case "state": {
        const st = msg.state!;
        // Ignore state older than a local takeback/end we've already applied.
        if (msg.type === "state" && st.revision < rev.current) break;
        setState(st);
        rev.current = st.revision;
        floor.current = st.floor;
        // The server is authoritative for the floor; keep the mixer in line with it.
        mixer.current?.setFloor(st.floor);
        if (st.floor !== "revoice") mixer.current?.stopClip();
        break;
      }
      case "action.accepted":
        bump("accepted");
        break;
      case "action.rejected":
        bump(msg.reason === "duplicate" ? "duplicate" : "stale");
        break;
      case "metric":
        if (msg.name === "takeback.remoteSilenceMs") bump("remoteSilence", msg.value);
        break;
    }
  }

  // ---- control ----
  function delegate() {
    sig.current?.send({ type: "control.delegate", actionId: uid(), revision: rev.current });
  }

  function takeBack() {
    // Silence locally FIRST. The server is told afterwards.
    const mx = mixer.current;
    if (!mx) return;
    const wasPlaying = mx.playing;
    const ms = mx.silenceAgent();
    floor.current = "alex";
    if (wasPlaying) bump("cuts");
    bump("localSilence", ms);
    rev.current++; // any in-flight clip for the old revision is now stale
    sig.current?.send({ type: "control.takeback", actionId: uid(), revision: rev.current - 1, localSilenceMs: ms });
    setClipStatus(wasPlaying ? "Cut off by takeback" : "");
  }

  function endCall() {
    mixer.current?.silenceAgent();
    mixer.current?.setFloor("ended");
    rev.current++;
    sig.current?.send({ type: "call.end", actionId: uid(), revision: rev.current - 1 });
    clips.current.clear();
  }

  // Esc always takes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        takeBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- clips ----
  function getClip(text: string): Promise<AudioBuffer> {
    let p = clips.current.get(text);
    if (!p) {
      p = (async () => {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS ${r.status}`);
        return mixer.current!.decode(await r.arrayBuffer());
      })();
      clips.current.set(text, p);
      p.catch(() => clips.current.delete(text));
    }
    return p;
  }

  async function prerender() {
    const t0 = performance.now();
    setClipStatus("Rendering…");
    try {
      await getClip(say);
      setClipStatus(`Ready (rendered in ${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      setClipStatus(`TTS failed: ${(e as Error).message}`);
    }
  }

  async function playClip(useTone: boolean) {
    const mx = mixer.current;
    if (!mx || floor.current !== "revoice") return;
    const tap = performance.now();
    const myRev = rev.current;
    let buf: AudioBuffer;
    try {
      buf = useTone ? mx.testTone() : await getClip(say);
    } catch (e) {
      setClipStatus(`TTS failed: ${(e as Error).message}`);
      return;
    }
    // Revision guard: if Alex took back while we waited, this generation must never play.
    if (myRev !== rev.current || floor.current !== "revoice") {
      bump("discarded");
      log(`generation.discarded (revision ${myRev} → ${rev.current})`);
      return;
    }
    mx.play(buf, myRev);
    bump("tapToFirstAudio", Math.round(performance.now() - tap));
    setClipStatus("Playing into Alex's line");
  }

  if (!joined) {
    return (
      <div className="wrap">
        <div className="card join">
          <h1>Alex's call desk</h1>
          <p className="hint">Call <b>{callId}</b>. Use headphones. Your mic goes through the ReVoice mixer before the caller hears it.</p>
          {err && <div className="alert bad">{err}</div>}
          <button className="btn primary" onClick={join}>Join call as Alex</button>
        </div>
      </div>
    );
  }

  const f = state?.floor ?? "alex";
  const callerHere = state?.peers.includes("caller");
  const fs =
    f === "ended" ? ["Call ended", "Rejoin to start again"]
    : f === "revoice" ? ["ReVoice has the floor", "Esc or Take back silences it instantly"]
    : ["You have the floor", "ReVoice is muted and only listening"];
  const ms = (v: number | null) => (v == null ? "–" : `${v} ms`);

  return (
    <div className="wrap">
      <div className="floor">
        <div className="pills">
          {(["alex", "caller", "revoice"] as const).map((k) => (
            <span key={k} className={`pill${f === k ? " on" : ""}${k === "revoice" && f === "revoice" ? " ai" : ""}`}>
              <i />
              {k === "alex" ? "Alex" : k === "caller" ? "Caller" : "ReVoice"}
            </span>
          ))}
        </div>
        <div className="fstate">
          <b>{fs[0]}</b>
          <small>{fs[1]}</small>
        </div>
        {f === "revoice" ? (
          <button className="btn take" onClick={takeBack}>Take back call <span className="kbd">Esc</span></button>
        ) : (
          <button className="btn primary" onClick={delegate} disabled={f === "ended"}>Let agent talk</button>
        )}
        <button className="btn ghost" onClick={endCall} disabled={f === "ended"}>End call</button>
      </div>

      <div className="hud inline">
        <span>Server <b>{ws}</b></span>
        <span>Audio link <b>{rtc}</b></span>
        <span>Caller <b>{callerHere ? "connected" : "waiting"}</b></span>
        <span>Revision <b>{state?.revision ?? "–"}</b></span>
        <span>Steering accepted <b>{m.accepted}</b></span>
        <span>Duplicate taps <b>{m.duplicate}</b></span>
        <span>Stale taps <b>{m.stale}</b></span>
        <span>Generations discarded <b>{m.discarded}</b></span>
        <span>Cut-offs <b>{m.cuts}</b></span>
        <span className="good">Late utterances <b>{m.late}</b></span>
        <span>Tap to first audio <b>{ms(m.tapToFirstAudio)}</b></span>
        <span>Takeback (local) <b>{ms(m.localSilence)}</b></span>
        <span className="good">Takeback → caller silent <b>{ms(m.remoteSilence)}</b></span>
      </div>

      <div className="grid2">
        <section className="card">
          <div className="ch"><h2>Voice check</h2><span className="tag">Kickoff tests</span></div>
          <p className="hint">
            1. Talk both ways. 2. Let agent talk, play a clip: the caller hears it, you hear it in your headphones.
            3. Press Esc mid-clip: the caller's laptop must go silent in under 250 ms.
          </p>
          <label className="lbl">Sentence to speak</label>
          <textarea value={say} onChange={(e) => setSay(e.target.value)} rows={3} />
          <div className="row">
            <button className="btn soft" onClick={prerender} disabled={!tts}>Pre-render (Gemini TTS)</button>
            <button className="btn soft" onClick={() => playClip(false)} disabled={!tts || f !== "revoice"}>Play TTS clip</button>
            <button className="btn soft" onClick={() => playClip(true)} disabled={f !== "revoice"}>Play test tone</button>
          </div>
          <p className="hint">
            {tts === false && "TTS is off: add GEMINI_API_KEY to .env and restart. The test tone works without it. "}
            {clipStatus}
          </p>
        </section>
        <section className="card">
          <div className="ch"><h2>Event stream</h2><span className="tag">Alex only</span></div>
          <pre className="events">{events.join("\n")}</pre>
        </section>
      </div>
      <audio ref={remoteAudio} autoPlay />
    </div>
  );
}
