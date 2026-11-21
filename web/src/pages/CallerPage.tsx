import { useEffect, useRef, useState } from "react";
import { PUBLIC_EVENTS, type ServerMsg } from "../../../shared/protocol.ts";
import { Signaling } from "../lib/signaling.ts";
import { AudioCall } from "../lib/rtc.ts";
import { getMic, watchLevel } from "../lib/mixer.ts";

/** The caller's laptop. It only ever sees public events and hears Alex's mixed line. */
export function CallerPage({ callId }: { callId: string }) {
  const [joined, setJoined] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ws, setWs] = useState("connecting");
  const [rtc, setRtc] = useState("idle");
  const [alexHere, setAlexHere] = useState(false);
  const [level, setLevel] = useState(0);
  const [privateSeen, setPrivateSeen] = useState(0);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const cleanup = useRef<(() => void)[]>([]);

  useEffect(() => () => cleanup.current.forEach((f) => f()), []);

  async function join() {
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const mic = await getMic(ctx);
      const s = new Signaling("caller", callId);
      s.onStatus = setWs;
      s.on((msg: ServerMsg) => {
        if (!PUBLIC_EVENTS.has(msg.type)) setPrivateSeen((n) => n + 1); // must stay 0
        if (msg.type === "peer.joined") setAlexHere(true);
        if (msg.type === "peer.left") setAlexHere(false);
      });
      const c = new AudioCall(s, mic.getAudioTracks()[0], false);
      c.onState = setRtc;
      c.onRemoteStream = (stream) => {
        const el = remoteAudio.current;
        if (!el) return;
        el.srcObject = stream;
        // Chrome only feeds a remote stream into Web Audio once a media element is playing it,
        // so attach the level watcher on `playing`, not on `ontrack`.
        el.addEventListener(
          "playing",
          () => cleanup.current.push(watchLevel(ctx, stream, setLevel, () => s.send({ type: "probe.silent" }))),
          { once: true },
        );
        setAlexHere(true);
      };
      cleanup.current.push(() => c.close(), () => s.close(), () => mic.getTracks().forEach((t) => t.stop()));
      setJoined(true);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
  }

  if (!joined) {
    return (
      <div className="wrap">
        <div className="card join">
          <h1>Caller</h1>
          <p className="hint">You're calling Alex (call <b>{callId}</b>). Captions are on for both sides; an AI assistant may join and will say so.</p>
          {err && <div className="alert bad">{err}</div>}
          <button className="btn primary" onClick={join}>Call Alex</button>
        </div>
      </div>
    );
  }

  const pct = Math.min(100, Math.round(level * 400));
  return (
    <div className="wrap">
      <div className="floor caller">
        <div className="fstate">
          <b>{rtc === "connected" ? "On a call with Alex" : alexHere ? "Connecting…" : "Ringing Alex…"}</b>
          <small>Server {ws} · audio {rtc}</small>
        </div>
      </div>
      <section className="card" style={{ marginTop: 14 }}>
        <div className="ch"><h2>What you hear</h2><span className="tag pub">Public audio</span></div>
        <div className="meter"><div style={{ width: `${pct}%` }} /></div>
        <p className="hint" style={{ marginTop: 10 }}>
          Private events received on this side: <b>{privateSeen}</b> (always 0). Directions, notes and warnings never reach the caller.
        </p>
      </section>
      <audio ref={remoteAudio} autoPlay />
    </div>
  );
}
