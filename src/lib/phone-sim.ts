/**
 * "Simulate an incoming call" on the phone, with no Twilio:
 * the phone asks the agent server (server/) to start a live-caller scenario. Gemini plays the
 * caller and reacts to what it hears; the agent answers right away. The phone plays both
 * voices, shows the usual notification and Live call screen, and steers the call
 * (Join = take over from the agent, End = hang up).
 *
 * The phone takes the role the web test desk has: it starts the call and reports when each
 * line has finished playing, which paces the caller and the agent's auto-speak.
 */
import { applyEvent } from '@/lib/call';
import { stopDemo } from '@/lib/demo';
import { notifyScreeningStarted } from '@/lib/notifications';
import {
  createCallMapper,
  markOwnCall,
  registerController,
  setOwnStarting,
  wsUrl,
  type SimMsg,
} from '@/lib/simulation';
import { settingsStore } from '@/lib/store';
import { AGENT_VOICE, CALLER_VOICE, cutLine, speak, stopSpeech } from '@/lib/voice';

export type SimKind = 'scam' | 'real';

let session: { ws: WebSocket; close: () => void } | null = null;

const uid = () => `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Starts a simulated call. Resolves once the call has started, rejects if the agent
 * server can't be reached.
 */
export function startPhoneSim(kind: SimKind): Promise<void> {
  const base = settingsStore.get().simServerUrl.trim().replace(/\/+$/, '');
  if (!base) return Promise.reject(new Error('Add the simulation server address in Setup first.'));

  session?.close();
  stopDemo();
  stopSpeech();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(base));
    let started = false;
    let delegated = false;
    let mapper: ReturnType<typeof createCallMapper> | null = null;
    let unregister: (() => void) | null = null;

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const close = () => {
      setOwnStarting(false);
      unregister?.();
      stopSpeech();
      ws.close();
      if (session?.ws === ws) session = null;
    };
    session = { ws, close };
    setOwnStarting(true);

    const fail = (message: string) => {
      close();
      if (!started) reject(new Error(message));
    };

    ws.onopen = () => send({ type: 'join', role: 'desk', callId: 'new' });
    ws.onerror = () => fail(`Can’t reach the simulation server at ${base}. Is it running?`);
    ws.onclose = () => {
      if (!started) fail('The simulation server closed the connection.');
      else if (mapper && !mapper.done()) mapper.finish();
    };

    ws.onmessage = (raw) => {
      if (typeof raw.data !== 'string') return;
      let m: SimMsg;
      try {
        m = JSON.parse(raw.data) as SimMsg;
      } catch {
        return;
      }

      if (m.type === 'desk.scenarios') {
        const kinds = kind === 'scam' ? ['scam'] : ['legit', 'everyday'];
        const pool = m.scenarios.filter((s) => kinds.includes(s.kind));
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (!pick) return fail('The simulation server has no scenarios of that kind.');
        send({ type: 'desk.start', scenarioId: pick.id, mode: 'live' });
        return;
      }

      if (m.type === 'call.started') {
        const callId = m.callId;
        started = true;
        markOwnCall(callId);
        setOwnStarting(false);
        mapper = createCallMapper(callId, (e) => applyEvent(e, false), () => setTimeout(close, 500));
        unregister = registerController(callId, { mapper, send });
        applyEvent({ type: 'call.started', callId, from: m.scenario.from }, false);
        void notifyScreeningStarted(callId, false);
        resolve();
        return;
      }

      if (!mapper) return;
      mapper.handle(m);

      switch (m.type) {
        case 'state':
          // The agent answers the call as soon as it rings: hand it the floor once.
          if (!delegated && m.floor === 'alex') {
            delegated = true;
            send({ type: 'control.delegate', actionId: uid(), revision: m.revision });
          }
          return;
        case 'turn.final':
          if (m.turn.speaker === 'caller') {
            const turnId = m.turn.turnId;
            speak(base, {
              id: turnId,
              text: m.turn.text,
              voice: CALLER_VOICE,
              // The agent's auto-speak clock starts once the caller has been heard.
              onDone: () => send({ type: 'desk.callerDone', turnId }),
            });
          }
          return;
        case 'agent.say': {
          const turnId = m.turnId;
          speak(base, {
            id: turnId,
            text: m.text,
            voice: AGENT_VOICE,
            onDone: (r) => r === 'ended' && send({ type: 'desk.agentDone', turnId }),
          });
          return;
        }
        case 'agent.cut':
          cutLine(m.turnId);
          return;
        case 'call.ended':
          // Let the caller's last words finish; the mapper closes the call after the review.
          return;
      }
    };
  });
}

/** Leaves the simulated call (stops audio and the connection). */
export function stopPhoneSim() {
  session?.close();
}
