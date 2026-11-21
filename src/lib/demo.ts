/**
 * Fake event scripts, so the Live screen can be built and demoed without the server.
 * Each one follows the agreed shape: call.started -> 4 transcript lines -> 2 signals -> verdict.
 */
import { applyEvent } from '@/lib/call';
import { notifyScreeningStarted } from '@/lib/notifications';
import type { ServerEvent } from '@/lib/protocol';

type Step = { at: number; event: ServerEvent };

function scamScript(callId: string): Step[] {
  return [
    { at: 0, event: { type: 'call.started', callId, from: '+15550132244' } },
    {
      at: 1500,
      event: { type: 'transcript', callId, turn: 1, speaker: 'agent', text: "Hi, you've reached an assistant. Who's calling, and what's it about?" },
    },
    {
      at: 4500,
      event: { type: 'transcript', callId, turn: 2, speaker: 'caller', text: "This is Officer Daniels with the IRS. There's a warrant out for her arrest over unpaid taxes." },
    },
    { at: 6500, event: { type: 'signal', callId, label: 'Claims to be the government', turn: 2 } },
    {
      at: 8500,
      event: { type: 'transcript', callId, turn: 3, speaker: 'agent', text: 'I can pass on a message. What is your badge number and a number to call you back?' },
    },
    {
      at: 11500,
      event: { type: 'transcript', callId, turn: 4, speaker: 'caller', text: "There's no time. She has to pay today with gift cards or the police will come." },
    },
    { at: 13000, event: { type: 'signal', callId, label: 'Asked for money', turn: 4 } },
    {
      at: 15000,
      event: {
        type: 'verdict',
        callId,
        verdict: 'scam',
        reasons: ['Pretended to be the IRS', 'Demanded gift card payment', 'Threatened arrest to rush you'],
      },
    },
  ];
}

function realScript(callId: string): Step[] {
  return [
    { at: 0, event: { type: 'call.started', callId, from: '+15550178890' } },
    {
      at: 1500,
      event: { type: 'transcript', callId, turn: 1, speaker: 'agent', text: "Hi, you've reached an assistant. Who's calling, and what's it about?" },
    },
    {
      at: 4500,
      event: { type: 'transcript', callId, turn: 2, speaker: 'caller', text: "Hi, it's Maya, her granddaughter. My phone died so I'm on a friend's." },
    },
    { at: 6500, event: { type: 'signal', callId, label: 'Calling from a new number', turn: 2 } },
    {
      at: 8500,
      event: { type: 'transcript', callId, turn: 3, speaker: 'agent', text: 'Thanks Maya. She may call you back on your usual number. Is that okay?' },
    },
    {
      at: 11500,
      event: { type: 'transcript', callId, turn: 4, speaker: 'caller', text: "Of course. Just tell her I'll be late for dinner." },
    },
    { at: 13000, event: { type: 'signal', callId, label: 'Happy to be called back', turn: 4 } },
    {
      at: 15000,
      event: {
        type: 'verdict',
        callId,
        verdict: 'real',
        reasons: ['Agreed to a callback on her usual number', 'No request for money or personal details'],
      },
    },
  ];
}

let timers: ReturnType<typeof setTimeout>[] = [];

export function stopDemo() {
  timers.forEach(clearTimeout);
  timers = [];
}

export function startDemo(kind: 'scam' | 'real') {
  stopDemo();
  const callId = `demo-${Date.now()}`;
  const steps = kind === 'scam' ? scamScript(callId) : realScript(callId);
  timers = steps.map(({ at, event }) =>
    setTimeout(() => {
      applyEvent(event, true);
      if (event.type === 'call.started') void notifyScreeningStarted(event.callId, true);
    }, at),
  );
}

/** Demo calls have no server: End and Block finish them locally. */
export function endDemoCall(callId: string) {
  stopDemo();
  applyEvent({ type: 'call.ended', callId }, true);
}
