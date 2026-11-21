import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AlexPage } from "./pages/AlexPage.tsx";
import { CallerPage } from "./pages/CallerPage.tsx";
import { DeskPage } from "./pages/DeskPage.tsx";
import "./styles.css";

const params = new URLSearchParams(location.search);
const callId = params.get("call") || "demo";
const path = location.pathname.replace(/\/+$/, "");

/** Two arcs turning back on themselves: the call, reversed. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0e1a2b" />
      <path d="M9 13a7 7 0 0 1 12.5-4.3M23 19a7 7 0 0 1-12.5 4.3" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M22.5 5.5v3.8h-3.8M9.5 26.5v-3.8h3.8" fill="none" stroke="#7f95ff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Home() {
  const q = `?call=${encodeURIComponent(callId)}`;
  return (
    <main className="home">
      <section className="hero">
        <div>
          <h1>They fake a voice.<span>We reverse the call.</span></h1>
          <p className="lede">
            When an unknown number calls, your own AI assistant answers. It says it's an AI, asks the questions a scam script can't answer,
            and shows you the risk as the call happens. You can step in at any moment, or let it handle the call.
          </p>
          <div className="actions">
            <a className="btn primary" href="/desk">Try a call</a>
            <a className="btn soft" href={`/alex${q}`}>Take a real call</a>
          </div>
        </div>
        <div className="preview" aria-label="Example: a fake family emergency call">
          <div className="pv-top"><span>Unknown number, says it's Maya</span><span className="num">1:12</span></div>
          <div className="pv-risk">High risk, confirmed</div>
          <div className="pv-line caller"><small>Caller</small>$900 for the tow. Venmo it to my friend, it has to be in the next ten minutes.</div>
          <div className="pv-line agent"><small>Your AI assistant</small>So Alex knows it's really you: what was the name of your first dog?</div>
          <div className="pv-line caller"><small>Caller</small>I can't think about that now! And don't call my number, it's broken.</div>
          <div className="pv-verdict">Dodged the family question and refused a callback after asking for money. Alex calls Maya on her saved number instead.</div>
        </div>
      </section>

      <section className="entries">
        <a className="entry" href="/desk">
          <h3>Try a call</h3>
          <p>Pick a scenario, from a fake bank to a real pharmacy. Gemini plays the caller, and you steer the assistant and watch the risk score live.</p>
          <span className="go">Open the call desk</span>
        </a>
        <a className="entry" href={`/alex${q}`}>
          <h3>Take a real call</h3>
          <p>On two laptops with headphones: you're Alex, a friend plays the caller. Hand the call to the assistant and take it back in one tap.</p>
          <span className="go">Open Alex's console</span>
        </a>
        <a className="entry" href={`/caller${q}`}>
          <h3>Be the caller</h3>
          <p>Join the same call from the second laptop and try to talk your way past the assistant.</p>
          <span className="go">Join as the caller</span>
        </a>
      </section>

      <p className="facts">
        <span><b>Always honest.</b> The assistant says it's an AI.</span>
        <span><b>Never commits.</b> It won't pay, approve or share a code.</span>
        <span><b>Checks the story, not the voice.</b> A cloned voice proves nothing.</span>
        <span><b>Gets better.</b> A critic reviews every call and teaches the next one.</span>
      </p>
    </main>
  );
}

function App() {
  const here = path === "/desk" ? "desk" : path === "/alex" || path === "/caller" ? "live" : "home";
  return (
    <>
      <header className="appbar">
        <div className="appbar-in">
          <a className="brand" href="/"><Mark /> ReVoice</a>
          <nav className="nav">
            <a href="/desk" aria-current={here === "desk" ? "page" : undefined}>Call desk</a>
            <a href={`/alex?call=${encodeURIComponent(callId)}`} aria-current={here === "live" ? "page" : undefined}>Live call</a>
          </nav>
          <span className="promise">The assistant always says it's an AI</span>
        </div>
      </header>
      {path === "/desk" ? <DeskPage /> : path === "/alex" ? <AlexPage callId={callId} /> : path === "/caller" ? <CallerPage callId={callId} /> : <Home />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
