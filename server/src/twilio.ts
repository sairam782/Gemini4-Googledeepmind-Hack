import type { WebSocket } from "ws";
import { LiveCall, type AgentVoice } from "./call.ts";
import { Transcriber } from "./transcribe.ts";
import { renderSpeech, ttsEnabled } from "./tts.ts";
import { decodeMulaw, encodeMulaw, parseWav, pcmBytes, resample } from "./audio.ts";

/**
 * Twilio Media Streams bridge (wss://<host>/twilio).
 *
 *   inbound track  (the caller)        → µ-law 8 kHz → 16 kHz PCM → Transcriber → LiveCall.caller()
 *   outbound track (Alex, if streamed) → same, as Alex
 *   agent.say                          → Gemini TTS → 8 kHz µ-law frames back into the call, then a "mark";
 *                                        Twilio echoes the mark when playback ends → agentDone
 *   takeback                           → "clear" stops playback on Twilio's side at once
 *
 * Use <Connect><Stream> (bidirectional) so the agent can speak. With <Start><Stream> (fork only),
 * transcription and the brain still work but the agent's audio can't be injected.
 * Custom <Parameter>s: from (caller number), inContacts ("true"/"false").
 */

const FRAME = 160; // 20 ms of 8 kHz µ-law

interface TwilioMsg {
  event: "connected" | "start" | "media" | "mark" | "stop" | "dtmf";
  start?: { streamSid: string; callSid: string; tracks?: string[]; customParameters?: Record<string, string> };
  media?: { track?: "inbound" | "outbound"; payload: string };
  mark?: { name: string };
  streamSid?: string;
}

const contacts = new Set((process.env.CONTACTS || "").split(",").map((s) => s.replace(/[^\d+]/g, "")).filter(Boolean));

export function handleTwilioStream(ws: WebSocket) {
  let call: LiveCall | null = null;
  let streamSid = "";
  const transcribers: Transcriber[] = [];
  let caller: Transcriber | null = null;
  let alex: Transcriber | null = null;

  const sendTwilio = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  const voice: AgentVoice = {
    speak(turnId, text) {
      if (!ttsEnabled()) return call?.agentDone(turnId);
      void renderSpeech(text)
        .then((wav) => {
          if (call?.agentSpeaking !== turnId) return; // taken back while rendering
          const { samples, rate } = parseWav(wav);
          const ulaw = encodeMulaw(resample(samples, rate, 8000));
          for (let i = 0; i < ulaw.length; i += FRAME) {
            sendTwilio({ event: "media", streamSid, media: { payload: ulaw.subarray(i, i + FRAME).toString("base64") } });
          }
          sendTwilio({ event: "mark", streamSid, mark: { name: turnId } });
        })
        .catch((e) => {
          call?.emit({ type: "error", message: `agent voice failed: ${(e as Error).message}` });
          call?.agentDone(turnId);
        });
    },
    cut() {
      sendTwilio({ event: "clear", streamSid });
    },
    prerender(texts) {
      if (ttsEnabled()) texts.forEach((t) => void renderSpeech(t).catch(() => {}));
    },
  };

  const feed = (t: Transcriber | null, payload: string) => {
    if (!t) return;
    const pcm8 = decodeMulaw(Buffer.from(payload, "base64"));
    t.push(pcmBytes(resample(pcm8, 8000, 16000)));
  };

  ws.on("message", (raw) => {
    let m: TwilioMsg;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (m.event) {
      case "start": {
        const s = m.start!;
        streamSid = s.streamSid;
        const p = s.customParameters ?? {};
        const from = p.from || "unknown number";
        const inContacts = p.inContacts ? p.inContacts === "true" : contacts.has(from.replace(/[^\d+]/g, ""));
        call = new LiveCall(s.callSid || streamSid, { from, inContacts });
        call.voice = voice;
        console.log(`[twilio] call ${call.id} from ${from} (${inContacts ? "contact" : "unknown"}), tracks ${s.tracks?.join("+") ?? "inbound"}`);
        const c = call;
        const onErr = (message: string) => c.emit({ type: "error", message });
        caller = new Transcriber({ interim: (t) => c.interim("caller", t), final: (t) => c.caller(t), error: onErr }, "caller");
        transcribers.push(caller);
        if (s.tracks?.includes("outbound")) {
          // Alex's side. Lines heard while the agent is talking are the agent's own audio: skip them.
          alex = new Transcriber({ interim: (t) => c.interim("alex", t), final: (t) => !c.agentSpeaking && c.alex(t, "phone"), error: onErr }, "alex");
          transcribers.push(alex);
        }
        call.state();
        return;
      }
      case "media":
        return feed(m.media?.track === "outbound" ? alex : caller, m.media!.payload);
      case "mark":
        return call?.agentDone(m.mark!.name);
      case "stop":
        call?.end("caller hung up");
        return;
    }
  });

  ws.on("close", () => {
    transcribers.forEach((t) => t.close());
    call?.end("phone stream closed");
  });
}

/** TwiML for the Twilio number's voice webhook: stream the call to us, bidirectionally. */
export function twiml(host: string, from: string) {
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${esc(host)}/twilio">
      <Parameter name="from" value="${esc(from)}"/>
    </Stream>
  </Connect>
</Response>`;
}
