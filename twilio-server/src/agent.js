// The voice agent: one Gemini Live session per call (GEMINI_LIVE_MODEL).
// Caller audio in (16 kHz PCM16), agent audio out (24 kHz PCM16), plus transcripts of both sides.

import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = () => process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const OWNER = () => process.env.OWNER_NAME || 'Alex';
const LANG = () => process.env.LANGUAGE || 'en-US';

let ai = null;
const client = () => (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

function prompt() {
  const owner = OWNER();
  return `You are a polite call screener answering the phone for ${owner}. ${owner} didn't pick up, so the call came to you.
Say at the start that you are ${owner}'s AI assistant screening the call.
Your job: find out who is calling and why, in a calm, friendly way. Ask one short question at a time.
Rules you never break:
- Never share anything personal about ${owner}: no address, schedule, accounts, family details, codes or numbers.
- Never agree to pay, send, buy or transfer anything. Never confirm, approve or promise anything on ${owner}'s behalf.
- Never read out or ask for codes, PINs, passwords or account numbers.
- If they want ${owner}, money, or a decision, offer: "She'll call you back on her usual number."
- If they pressure you or say it's urgent, stay calm and repeat that ${owner} will call back on her usual number.
- Keep each reply to one or two short sentences, like a real phone call. Don't say "scam" to the caller.
- Always speak English, even if the caller's audio sounds like another language.
Sometimes you get a private note from ${owner} in brackets. Follow it in your next line, and never say you got a note.`;
}

/**
 * Starts the agent. Callbacks:
 *  onAudio(pcm16Buffer, rate)  agent speech to play into the call
 *  onInterrupted()             the caller talked over the agent: stop playback now
 *  onCallerLine(text)          a finished caller line (transcript)
 *  onAgentLine(text, cut)      a finished agent line (transcript)
 *  onError(message)
 * Returns { sendAudio(pcm16k Buffer), steer(text), close() }.
 */
export function startAgent(cb) {
  let session = null;
  let closed = false;
  const queue = [];
  let callerBuf = '';
  let agentBuf = '';

  const flushCaller = () => {
    const t = callerBuf.replace(/\s+/g, ' ').trim();
    callerBuf = '';
    if (t) cb.onCallerLine(t);
  };
  const flushAgent = (cut = false) => {
    const t = agentBuf.replace(/\s+/g, ' ').trim();
    agentBuf = '';
    if (t) cb.onAgentLine(t, cut);
  };

  const onmessage = (m) => {
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) callerBuf += sc.inputTranscription.text;
    if (sc.interrupted) {
      cb.onInterrupted();
      flushAgent(true);
      return;
    }
    const parts = sc.modelTurn?.parts || [];
    const speaking = parts.some((p) => p.inlineData?.data) || sc.outputTranscription?.text;
    // The model answering means the caller's line is over.
    if (speaking && callerBuf) flushCaller();
    for (const p of parts) {
      if (p.inlineData?.data) {
        const rate = Number(/rate=(\d+)/.exec(p.inlineData.mimeType || '')?.[1]) || 24000;
        cb.onAudio(Buffer.from(p.inlineData.data, 'base64'), rate);
      }
    }
    if (sc.outputTranscription?.text) agentBuf += sc.outputTranscription.text;
    if (sc.turnComplete) {
      flushCaller();
      flushAgent();
    }
  };

  client()
    .live.connect({
      model: MODEL(),
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: prompt(),
        // Phone audio is low quality and Live may guess the wrong language: pin it (LANGUAGE, default en-US).
        // (Transcription language can't be pinned with an API key; the prompt keeps the agent in English.)
        speechConfig: { languageCode: LANG() },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage,
        onerror: (e) => cb.onError(`Gemini Live: ${e?.message || e}`),
        onclose: (e) => {
          session = null;
          if (!closed && e?.reason) cb.onError(`Gemini Live closed: ${e.reason}`);
        },
      },
    })
    .then((s) => {
      if (closed) return s.close();
      session = s;
      // Answer the phone first, like a person would.
      s.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: '[The call just connected. Greet the caller now.]' }] }],
        turnComplete: true,
      });
      for (const b64 of queue.splice(0)) s.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
    })
    .catch((e) => cb.onError(`Gemini Live failed to connect: ${e?.message || e}`));

  return {
    sendAudio(pcm16k) {
      if (closed) return;
      const b64 = pcm16k.toString('base64');
      if (!session) {
        queue.push(b64);
        if (queue.length > 300) queue.shift();
        return;
      }
      session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
    },
    /** Steering from the app: a private instruction, or (exact) the exact words to say next. */
    steer(text, exact = false) {
      if (!session) throw new Error('The agent is not connected yet.');
      const note = exact
        ? `[Private note from ${OWNER()}: say exactly this to the caller now, nothing else: "${text}"]`
        : `[Private note from ${OWNER()}: ${text}]`;
      // Mid-call input goes through the realtime channel (made for live updates; clientContent is for setup).
      session.sendRealtimeInput({ text: note });
    },
    close() {
      closed = true;
      flushCaller();
      flushAgent();
      try {
        session?.close();
      } catch {
        // already closed
      }
      session = null;
    },
  };
}
