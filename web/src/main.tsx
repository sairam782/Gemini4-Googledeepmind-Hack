import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AlexPage } from "./pages/AlexPage.tsx";
import { CallerPage } from "./pages/CallerPage.tsx";
import "./styles.css";

const params = new URLSearchParams(location.search);
const callId = params.get("call") || "demo";
const path = location.pathname.replace(/\/+$/, "");

function Home() {
  const q = `?call=${encodeURIComponent(callId)}`;
  return (
    <div className="wrap">
      <div className="card join">
        <h1>Uno ReVoice</h1>
        <p className="hint">Open one role per laptop, both on headphones.</p>
        <div className="row">
          <a className="btn primary" href={`/alex${q}`}>I'm Alex (recipient)</a>
          <a className="btn soft" href={`/caller${q}`}>I'm the caller</a>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <header>
        <div className="logo">≋</div>
        <b>Uno ReVoice</b>
        <span className="badge">Captions consented · nothing stored</span>
      </header>
      {path === "/alex" ? <AlexPage callId={callId} /> : path === "/caller" ? <CallerPage callId={callId} /> : <Home />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
