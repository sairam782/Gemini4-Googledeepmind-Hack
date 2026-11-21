import type { Direction, ServerEvent, Speaker, Verdict } from '@/lib/protocol';
import { redactSafeWords } from '@/lib/redact';
import { addHistory, createStore, safeWordsStore } from '@/lib/store';

export type Turn = { turn: number; speaker: Speaker; text: string };
export type WarningSign = { label: string; turn: number };

export type LiveCall = {
  callId: string;
  from: string;
  startedAt: number;
  transcript: Turn[];
  signals: WarningSign[];
  verdict: Verdict | null;
  reasons: string[];
  /** Suggested next lines for the agent (Simulation and Live). */
  directions: Direction[];
  ended: boolean;
  endedAt: number | null;
  joining: boolean;
  joined: boolean;
  blocked: boolean;
  /** Demo calls come from the fake event script, not the server. */
  demo: boolean;
};

export const callStore = createStore<LiveCall | null>(null);

function newCall(callId: string, from: string, demo: boolean): LiveCall {
  return {
    callId,
    from,
    startedAt: Date.now(),
    transcript: [],
    signals: [],
    verdict: null,
    reasons: [],
    directions: [],
    ended: false,
    endedAt: null,
    joining: false,
    joined: false,
    blocked: false,
    demo,
  };
}

function saveToHistory(call: LiveCall) {
  const safeWords = safeWordsStore.get();
  addHistory({
    callId: call.callId,
    from: call.from,
    startedAt: call.startedAt,
    endedAt: call.endedAt ?? Date.now(),
    verdict: call.verdict,
    reasons: call.reasons.map((r) => redactSafeWords(r, safeWords)),
    blocked: call.blocked,
    demo: call.demo,
  });
}

export function updateCall(patch: Partial<LiveCall>) {
  callStore.set((c) => (c ? { ...c, ...patch } : c));
}

/** Applies one server (or demo) event to the live call. */
export function applyEvent(e: ServerEvent, demo = false) {
  let current = callStore.get();

  if (e.type === 'call.started') {
    if (current && !current.ended) saveToHistory({ ...current, ended: true, endedAt: Date.now() });
    callStore.set(newCall(e.callId, e.from, demo));
    return;
  }

  // Joined mid-call (app opened after call.started): start a call so nothing is dropped.
  if (!current || current.callId !== e.callId) {
    if (e.type === 'call.ended') return;
    if (current && !current.ended) saveToHistory({ ...current, ended: true, endedAt: Date.now() });
    current = newCall(e.callId, '', demo);
  }
  if (current.ended) return;

  switch (e.type) {
    case 'transcript': {
      const turns = current.transcript.filter((t) => t.turn !== e.turn || t.speaker !== e.speaker);
      turns.push({ turn: e.turn, speaker: e.speaker, text: e.text });
      turns.sort((a, b) => a.turn - b.turn);
      callStore.set({ ...current, transcript: turns });
      return;
    }
    case 'signal': {
      if (current.signals.some((s) => s.label === e.label)) return;
      callStore.set({ ...current, signals: [...current.signals, { label: e.label, turn: e.turn }] });
      return;
    }
    case 'signal.removed':
      callStore.set({ ...current, signals: current.signals.filter((s) => s.label !== e.label) });
      return;
    case 'directions':
      callStore.set({ ...current, directions: e.directions });
      return;
    case 'verdict':
      callStore.set({ ...current, verdict: e.verdict, reasons: e.reasons });
      return;
    case 'call.ended': {
      const ended = { ...current, ended: true, endedAt: Date.now(), joining: false };
      callStore.set(ended);
      saveToHistory(ended);
      return;
    }
  }
}

/** Clears the finished call from the Live screen. */
export function dismissCall() {
  const c = callStore.get();
  if (c && !c.ended) return;
  callStore.set(null);
}
