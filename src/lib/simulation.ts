/**
 * Web simulation: listens to Abhi's agent server (server/) instead of the phone server.
 *
 * Calls are started from the web test desk (https://localhost:5173/desk) or come in through
 * that server's own Twilio bridge. This file turns its events (shared/brain.ts) into the app's
 * events (protocol.ts), so the Live call screen works the same way for both backends.
 *
 * That server's events carry no call ID, so the app finds calls through GET /api/health
 * (which lists them, newest last) and joins each new one over /ws.
 */
import type { ServerEvent, Verdict } from '@/lib/protocol';

type Level = 'Low' | 'Medium' | 'High';
type SimSign = { id: string; label: string; evidenceTurnId: string; status: 'provisional' | 'confirmed' | 'removed' };
type SimMsg =
  | { type: 'state'; floor: 'alex' | 'agent' | 'ended'; revision: number }
  | { type: 'turn.final'; turn: { turnId: string; n: number; speaker: 'caller' | 'alex' | 'agent'; text: string } }
  | { type: 'risk.signal'; sign: SimSign }
  | { type: 'risk.level'; risk: { level: Level; locked: boolean } }
  | { type: 'call.ended'; reason: string }
  | { type: 'call.review'; review: { verdict: 'scam' | 'legit' | 'unclear'; summary: string } }
  | { type: 'action.accepted'; revision: number }
  | { type: 'action.rejected'; revision: number; reason: string }
  | { type: 'error'; message: string };

const POLL_MS = 2000;
/** How long to wait for the call review after hang-up before closing the call anyway. */
const REVIEW_WAIT_MS = 20000;

const turnNumber = (turnId: string) => Number(turnId.replace(/\D/g, '')) || 0;

/** Desk calls are named "<scenario>-<time>"; Twilio calls use the CallSid. */
function callerLabel(callId: string) {
  const m = /^([a-z0-9_]+)-\d{10,}$/i.exec(callId);
  return m ? `Simulated call (${m[1]})` : '';
}

type Active = { callId: string; ws: WebSocket; revision: number; signs: Map<string, SimSign>; endTimer: ReturnType<typeof setTimeout> | null; done: boolean };
let active: Active | null = null;

/** Sends a control message for the current simulated call. */
function control(type: 'control.takeback' | 'call.end') {
  if (!active || active.done || active.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected to the simulated call.');
  }
  const msg: Record<string, unknown> = { type, actionId: `app-${Date.now()}`, revision: active.revision };
  if (type === 'control.takeback') msg.localSilenceMs = 0;
  active.ws.send(JSON.stringify(msg));
}

/** Join: take the call back from the agent (the user speaks from now on). */
export const simTakeBack = () => control('control.takeback');
/** End: hang up the simulated call. */
export const simEnd = () => control('call.end');

/**
 * Polls the agent server and follows its newest call.
 * `emit` receives app events; `onStatus` reports whether the server is reachable.
 */
export function connectSimulation(
  baseUrl: string,
  emit: (e: ServerEvent) => void,
  onStatus: (online: boolean) => void,
): () => void {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const wsBase = base.replace(/^http/i, 'ws');
  const finished = new Set<string>();
  let first = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (a: Active) => {
    if (a.done) return;
    a.done = true;
    if (a.endTimer) clearTimeout(a.endTimer);
    finished.add(a.callId);
    emit({ type: 'call.ended', callId: a.callId });
    a.ws.close();
  };

  const verdictNow = (a: Active, level: Level, locked: boolean) => {
    const reasons = [...a.signs.values()].filter((s) => s.status !== 'removed').map((s) => s.label);
    if (locked) reasons.unshift('High risk: confirmed');
    const verdict: Verdict = level === 'High' ? 'scam' : 'unsure';
    emit({ type: 'verdict', callId: a.callId, verdict, reasons });
  };

  const handle = (a: Active, m: SimMsg) => {
    const callId = a.callId;
    switch (m.type) {
      case 'state':
      case 'action.accepted':
        a.revision = m.revision;
        return;
      case 'turn.final': {
        const speaker = m.turn.speaker === 'alex' ? 'you' : m.turn.speaker;
        emit({ type: 'transcript', callId, turn: m.turn.n, speaker, text: m.turn.text });
        return;
      }
      case 'risk.signal': {
        const prev = a.signs.get(m.sign.id);
        a.signs.set(m.sign.id, m.sign);
        if (m.sign.status === 'removed') {
          if (prev) emit({ type: 'signal.removed', callId, label: prev.label });
        } else {
          emit({ type: 'signal', callId, label: m.sign.label, turn: turnNumber(m.sign.evidenceTurnId) });
        }
        return;
      }
      case 'risk.level':
        verdictNow(a, m.risk.level, m.risk.locked);
        return;
      case 'call.ended':
        // Wait for the review so the final verdict lands before the call closes.
        a.endTimer = setTimeout(() => finish(a), REVIEW_WAIT_MS);
        return;
      case 'call.review': {
        const verdict: Verdict = m.review.verdict === 'scam' ? 'scam' : m.review.verdict === 'legit' ? 'real' : 'unsure';
        emit({ type: 'verdict', callId, verdict, reasons: [m.review.summary] });
        finish(a);
        return;
      }
      case 'action.rejected':
        a.revision = m.revision;
        console.warn('Agent server rejected the action:', m.reason);
        return;
      case 'error':
        console.warn('Agent server:', m.message);
        return;
    }
  };

  const join = (callId: string) => {
    if (active && !active.done) {
      // A newer call replaces the one we were watching.
      finish(active);
    }
    const a: Active = { callId, ws: new WebSocket(`${wsBase}/ws`), revision: 1, signs: new Map(), endTimer: null, done: false };
    active = a;
    emit({ type: 'call.started', callId, from: callerLabel(callId) });
    a.ws.onopen = () => a.ws.send(JSON.stringify({ type: 'join', role: 'app', callId }));
    a.ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string' || a.done) return;
      try {
        handle(a, JSON.parse(msg.data) as SimMsg);
      } catch {
        // ignore malformed frames
      }
    };
    a.ws.onclose = () => {
      // Dropped mid-call: forget it so the next poll joins again (the server replays everything).
      if (!a.done && active === a) active = null;
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
        ids.slice(0, -1).forEach((id) => finished.add(id));
        first = false;
      }
      const newest = ids.at(-1);
      if (newest && !finished.has(newest) && active?.callId !== newest) join(newest);
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
      if (active.endTimer) clearTimeout(active.endTimer);
      active.done = true;
      active.ws.close();
      active = null;
    }
  };
}
