// Live calls, phone-app sockets, registered devices, push and the block list.
// Events go to the app in exactly its format (src/lib/protocol.ts in the app):
//   call.started {callId, from} · transcript {callId, turn, speaker, text}
//   signal {callId, label, turn} · verdict {callId, verdict, reasons} · call.ended {callId}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA, { recursive: true });

const load = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
};
const save = (name, value) => writeFileSync(join(DATA, name), JSON.stringify(value, null, 2));

export const digits = (n) => String(n || '').replace(/[^\d+]/g, '');
const same = (a, b) => {
  const x = digits(a).replace(/^\+?1(?=\d{10}$)/, '');
  const y = digits(b).replace(/^\+?1(?=\d{10}$)/, '');
  return x.length >= 7 && x === y;
};

// ---------------------------------------------------------------- devices (POST /api/device)

/** phone → { pushToken, platform, at } */
const devices = load('devices.json', {});

export function saveDevice(phone, pushToken, platform) {
  devices[digits(phone)] = { pushToken: pushToken || null, platform: platform || '', at: Date.now() };
  save('devices.json', devices);
}

/** The most recently registered phone: the user this server screens for (one user per server). */
export function ownerPhone() {
  const latest = Object.entries(devices).sort((a, b) => b[1].at - a[1].at)[0];
  return latest?.[0] || '';
}

// ---------------------------------------------------------------- block list

const blocked = new Set(load('blocked.json', []));
export const isBlocked = (number) => [...blocked].some((b) => same(b, number));
export function block(number) {
  if (!digits(number)) return;
  blocked.add(digits(number));
  save('blocked.json', [...blocked]);
}

// ---------------------------------------------------------------- app sockets (WS /app?phone=)

const apps = new Set(); // { ws, phone }

function deliver(event, call) {
  const msg = JSON.stringify(event);
  for (const a of apps) {
    // A socket with a phone only gets that user's calls; calls with no known owner go to everyone.
    if (call.owner && a.phone && !same(a.phone, call.owner)) continue;
    if (a.ws.readyState === a.ws.OPEN) a.ws.send(msg);
  }
}

export function addApp(ws, phone) {
  const a = { ws, phone: digits(phone) };
  apps.add(a);
  ws.on('close', () => apps.delete(a));
  // Joined mid-call: replay what the call has said so far.
  for (const call of calls.values()) {
    if (call.ended) continue;
    if (call.owner && a.phone && !same(a.phone, call.owner)) continue;
    for (const e of call.history) ws.send(JSON.stringify(e));
  }
}

// ---------------------------------------------------------------- calls

/** callId → { callId, from, owner, startedAt, history[], turn, ended, joined, ...bridge fields } */
export const calls = new Map();

export function startCall(callId, from, owner) {
  let call = calls.get(callId);
  if (call) return call;
  call = { callId, from, owner: digits(owner), startedAt: Date.now(), history: [], turn: 0, ended: false, joined: false };
  calls.set(callId, call);
  emit(call, { type: 'call.started', from });
  void push(call);
  return call;
}

/** Sends one app event for this call (callId is added here). */
export function emit(call, event) {
  if (call.ended && event.type !== 'verdict') return;
  const e = { ...event, callId: call.callId };
  call.history.push(e);
  deliver(e, call);
}

export const nextTurn = (call) => ++call.turn;

/** Ends the call once (verdict first, then call.ended). */
export async function endCall(call, reason = '') {
  if (!call || call.ending) return;
  call.ending = true;
  console.log(`[call ${call.callId}] ended${reason ? `: ${reason}` : ''}`);
  call.agent?.close();
  await call.brain?.finish().catch(() => {});
  emit(call, { type: 'call.ended' });
  call.ended = true;
  setTimeout(() => calls.delete(call.callId), 10 * 60_000);
}

// ---------------------------------------------------------------- Expo push

async function push(call) {
  const targets = Object.entries(devices).filter(([phone, d]) => d.pushToken && (!call.owner || same(phone, call.owner)));
  if (targets.length === 0) return;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        targets.map(([, d]) => ({
          to: d.pushToken,
          title: 'Unknown caller',
          body: 'Agent is screening',
          data: { callId: call.callId },
          channelId: 'screened-calls',
          sound: 'default',
          priority: 'high',
        })),
      ),
    });
    if (!res.ok) console.warn(`[push] ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[push] failed: ${e.message}`);
  }
}
