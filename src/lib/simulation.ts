/**
 * AI simulation: talks to Abhi's agent server (server/) instead of the phone server.
 *
 * Two ways a call gets here:
 *  - The phone starts one itself (phone-sim.ts): Gemini plays the caller, the agent answers.
 *  - The app watches the server (connectSimulation below) and joins any call started elsewhere,
 *    e.g. on the web test desk or through the server's own Twilio bridge.
 *
 * Either way, this file turns the server's events (shared/brain.ts) into the app's events
 * (protocol.ts), so the Live call screen works the same for every backend.
 */
import type { ServerEvent, Verdict } from '@/lib/protocol';

type Level = 'Low' | 'Medium' | 'High';
type SimSign = { id: string; label: string; evidenceTurnId: string; status: 'provisional' | 'confirmed' | 'removed' };
export type SimMsg =
  | { type: 'desk.scenarios'; scenarios: { id: string; kind: 'scam' | 'legit' | 'everyday'; from: string; title: string }[] }
  | { type: 'call.started'; callId: string; scenario: { from: string; title: string } }
  | { type: 'state'; floor: 'alex' | 'agent' | 'ended'; revision: number }
  | { type: 'turn.final'; turn: { turnId: string; n: number; speaker: 'caller' | 'alex' | 'agent'; text: string } }
  | { type: 'agent.say'; turnId: string; text: string }
  | { type: 'agent.cut'; turnId: string }
  | { type: 'risk.signal'; sign: SimSign }
  | { type: 'risk.level'; risk: { level: Level; locked: boolean } }
  | { type: 'call.ended'; reason: string }
  | { type: 'call.review'; review: { verdict: 'scam' | 'legit' | 'unclear'; summary: string } }
  | { type: 'action.accepted'; revision: number }
  | { type: 'action.rejected'; revision: number; reason: string }
  | { type: 'error'; message: string };

/** How long to wait for the call review after hang-up before closing the call anyway. */
const REVIEW_WAIT_MS = 20000;
const POLL_MS = 2000;

export const wsUrl = (baseUrl: string) => `${baseUrl.trim().replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws`;

// ---------------------------------------------------------------------------
// Event translation for one call
// ---------------------------------------------------------------------------

export type CallMapper = {
  readonly callId: string;
  /** Latest revision from the server; every tap must carry it. */
  revision: () => number;
  handle: (m: SimMsg) => void;
  /** Closes the call on the app side (sends call.ended once). */
  finish: () => void;
  done: () => boolean;
};

export function createCallMapper(callId: string, emit: (e: ServerEvent) => void, onFinish: () => void): CallMapper {
  let revision = 1;
  let done = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  const signs = new Map<string, SimSign>();

  const finish = () => {
    if (done) return;
    done = true;
    if (endTimer) clearTimeout(endTimer);
    emit({ type: 'call.ended', callId });
    onFinish();
  };

  const handle = (m: SimMsg) => {
    if (done) return;
    switch (m.type) {
      case 'state':
      case 'action.accepted':
      case 'action.rejected':
        revision = m.revision;
        if (m.type === 'action.rejected') console.warn('Agent server rejected the action:', m.reason);
        return;
      case 'turn.final': {
        const speaker = m.turn.speaker === 'alex' ? 'you' : m.turn.speaker;
        emit({ type: 'transcript', callId, turn: m.turn.n, speaker, text: m.turn.text });
        return;
      }
      case 'risk.signal': {
        const prev = signs.get(m.sign.id);
        signs.set(m.sign.id, m.sign);
        if (m.sign.status === 'removed') {
          if (prev) emit({ type: 'signal.removed', callId, label: prev.label });
        } else {
          emit({ type: 'signal', callId, label: m.sign.label, turn: Number(m.sign.evidenceTurnId.replace(/\D/g, '')) || 0 });
        }
        return;
      }
      case 'risk.level': {
        const reasons = [...signs.values()].filter((s) => s.status !== 'removed').map((s) => s.label);
        if (m.risk.locked) reasons.unshift('High risk: confirmed');
        const verdict: Verdict = m.risk.level === 'High' ? 'scam' : 'unsure';
        emit({ type: 'verdict', callId, verdict, reasons });
        return;
      }
      case 'call.ended':
        // Wait for the review so the final verdict lands before the call closes.
        endTimer = setTimeout(finish, REVIEW_WAIT_MS);
        return;
      case 'call.review': {
        const v = m.review.verdict;
        const verdict: Verdict = v === 'scam' ? 'scam' : v === 'legit' ? 'real' : 'unsure';
        emit({ type: 'verdict', callId, verdict, reasons: [m.review.summary] });
        finish();
        return;
      }
      case 'error':
        console.warn('Agent server:', m.message);
        return;
    }
  };

  return { callId, revision: () => revision, handle, finish, done: () => done };
}

// ---------------------------------------------------------------------------
// Controls (Join / End) for whichever simulated call is on screen
// ---------------------------------------------------------------------------

type Controller = { mapper: CallMapper; send: (msg: object) => void };
const controllers = new Map<string, Controller>();

export function registerController(callId: string, c: Controller) {
  controllers.set(callId, c);
  return () => {
    if (controllers.get(callId) === c) controllers.delete(callId);
  };
}

/** True when this call comes from the agent server (so Join/End go there). */
export const isSimCall = (callId: string) => controllers.has(callId);

function control(callId: string, type: 'control.takeback' | 'call.end') {
  const c = controllers.get(callId);
  if (!c || c.mapper.done()) throw new Error('Not connected to this call any more.');
  const msg: Record<string, unknown> = { type, actionId: `app-${Date.now()}`, revision: c.mapper.revision() };
  if (type === 'control.takeback') msg.localSilenceMs = 0;
  c.send(msg);
}

/** Join: take the call back from the agent. */
export const simTakeBack = (callId: string) => control(callId, 'control.takeback');
/** End: hang up. */
export const simEnd = (callId: string) => control(callId, 'call.end');

// ---------------------------------------------------------------------------
// Calls this phone started itself; the watcher below must not join them a second time.
// ---------------------------------------------------------------------------

const ownCalls = new Set<string>();
let ownStarting = false;
export const markOwnCall = (callId: string) => ownCalls.add(callId);
export const setOwnStarting = (v: boolean) => {
  ownStarting = v;
};

// ---------------------------------------------------------------------------
// Watcher: follow calls started elsewhere (web desk, the server's Twilio bridge)
// ---------------------------------------------------------------------------

/**
 * Polls the agent server and joins its newest call as the phone app.
 * The server's events carry no call ID, so calls are found through GET /api/health (newest last).
 * Off the server's own computer, joining needs the server's APP_TOKEN (Setup → App token).
 */
export function connectSimulation(
  baseUrl: string,
  token: string,
  emit: (e: ServerEvent) => void,
  onStatus: (online: boolean) => void,
): () => void {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const seen = new Set<string>();
  let first = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: { mapper: CallMapper; ws: WebSocket; unregister: () => void } | null = null;

  const join = (callId: string) => {
    if (active && !active.mapper.done()) active.mapper.finish();
    seen.add(callId);
    const ws = new WebSocket(wsUrl(base));
    const mapper = createCallMapper(callId, emit, () => ws.close());
    const unregister = registerController(callId, { mapper, send: (msg) => ws.send(JSON.stringify(msg)) });
    const a = { mapper, ws, unregister };
    active = a;
    emit({ type: 'call.started', callId, from: callerLabel(callId) });
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', role: 'app', callId, ...(token ? { token } : {}) }));
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      try {
        mapper.handle(JSON.parse(msg.data) as SimMsg);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      unregister();
      // Dropped mid-call: forget it so the next poll joins again (the server replays everything).
      if (!mapper.done() && active === a) {
        seen.delete(callId);
        active = null;
      }
    };
  };

  const poll = async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      const body = (await res.json()) as { calls?: string[] };
      if (stopped) return;
      onStatus(true);
      const ids = body.calls ?? [];
      if (first) {
        // Calls from before the app connected are history, except the newest one, which may still be live.
        ids.slice(0, -1).forEach((id) => seen.add(id));
        first = false;
      }
      const newest = ids.at(-1);
      if (newest && !ownStarting && !ownCalls.has(newest) && !seen.has(newest)) join(newest);
    } catch {
      if (!stopped) onStatus(false);
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  };

  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (active) {
      active.unregister();
      active.ws.close();
      active = null;
    }
  };
}

/** Desk calls are named "<scenario>-<time>"; Twilio calls use the CallSid. */
function callerLabel(callId: string) {
  const m = /^([a-z0-9_-]+?)-\d{10,}$/i.exec(callId);
  return m ? `Simulated call (${m[1]})` : '';
}
