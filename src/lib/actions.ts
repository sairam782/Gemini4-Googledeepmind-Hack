import { callStore, updateCall } from '@/lib/call';
import { endDemoCall } from '@/lib/demo';
import { blockNumber, endCall, joinCall } from '@/lib/server';
import { addBlocked, markHistoryBlocked, settingsStore } from '@/lib/store';

/** Join: the server has Twilio ring the user's real phone and bridges them to the caller. */
export async function join() {
  const call = callStore.get();
  if (!call || call.ended) return;
  if (call.demo) {
    updateCall({ joined: true });
    return;
  }
  const { myPhone } = settingsStore.get();
  if (!myPhone) throw new Error('Add your phone number in Setup so the agent can ring you.');
  updateCall({ joining: true });
  try {
    await joinCall(call.callId, myPhone);
    updateCall({ joining: false, joined: true });
  } catch (e) {
    updateCall({ joining: false });
    throw e;
  }
}

/** End: the server hangs up. The call is closed for good when call.ended arrives. */
export async function end() {
  const call = callStore.get();
  if (!call || call.ended) return;
  if (call.demo) {
    endDemoCall(call.callId);
    return;
  }
  await endCall(call.callId);
}

/** Block: saved on the phone and on the server, then the call is hung up. */
export async function block() {
  const call = callStore.get();
  if (!call) return;
  if (call.from) addBlocked(call.from);
  updateCall({ blocked: true });
  if (call.ended) markHistoryBlocked(call.callId);
  if (call.demo) {
    if (!call.ended) endDemoCall(call.callId);
    return;
  }
  await blockNumber(settingsStore.get().myPhone, call.from, call.callId);
  if (!call.ended) await endCall(call.callId);
}
