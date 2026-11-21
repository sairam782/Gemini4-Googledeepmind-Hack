/**
 * Messages the server sends the app over the WebSocket, as agreed with Abhi.
 * Every message is one JSON object with a `type` field naming the event.
 */

export type Speaker = 'caller' | 'agent';
export type Verdict = 'scam' | 'real' | 'unsure';

export type CallStartedEvent = { type: 'call.started'; callId: string; from: string };
export type TranscriptEvent = { type: 'transcript'; callId: string; turn: number; speaker: Speaker; text: string };
export type SignalEvent = { type: 'signal'; callId: string; label: string; turn: number };
export type VerdictEvent = { type: 'verdict'; callId: string; verdict: Verdict; reasons: string[] };
export type CallEndedEvent = { type: 'call.ended'; callId: string };

export type ServerEvent = CallStartedEvent | TranscriptEvent | SignalEvent | VerdictEvent | CallEndedEvent;

const VERDICTS: readonly string[] = ['scam', 'real', 'unsure'];

/** Parses one WebSocket frame. Returns null for anything that isn't a valid event. */
export function parseServerEvent(raw: string): ServerEvent | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const e = m as Record<string, unknown>;
  if (typeof e.callId !== 'string') return null;

  switch (e.type) {
    case 'call.started':
      return typeof e.from === 'string' ? { type: e.type, callId: e.callId, from: e.from } : null;
    case 'transcript':
      return typeof e.turn === 'number' &&
        (e.speaker === 'caller' || e.speaker === 'agent') &&
        typeof e.text === 'string'
        ? { type: e.type, callId: e.callId, turn: e.turn, speaker: e.speaker, text: e.text }
        : null;
    case 'signal':
      return typeof e.label === 'string' && typeof e.turn === 'number'
        ? { type: e.type, callId: e.callId, label: e.label, turn: e.turn }
        : null;
    case 'verdict': {
      if (typeof e.verdict !== 'string' || !VERDICTS.includes(e.verdict)) return null;
      // Accept a single string as well as a list, in case the server sends one reason.
      const reasons = Array.isArray(e.reasons)
        ? e.reasons.filter((r): r is string => typeof r === 'string')
        : typeof e.reasons === 'string'
          ? [e.reasons]
          : [];
      return { type: e.type, callId: e.callId, verdict: e.verdict as Verdict, reasons };
    }
    case 'call.ended':
      return { type: e.type, callId: e.callId };
    default:
      return null;
  }
}
