/**
 * Everything the app sends to the phone server (twilio-server/, Live mode) lives in this file.
 * The WebSocket message format is in protocol.ts.
 *
 * Twilio credentials (Account SID / Auth Token) stay on the server. They never belong in the app.
 */
import type { SafeWord } from '@/lib/store';
import { settingsStore } from '@/lib/store';

export class ServerError extends Error {}

function baseUrl(): string {
  const url = settingsStore.get().serverUrl.trim().replace(/\/+$/, '');
  if (!url) throw new ServerError('Add the server address in Setup first.');
  return url;
}

export function isHttps(url: string) {
  return /^https:\/\//i.test(url.trim());
}

/** ws(s)://<server>/app?phone=<my number> */
export function webSocketUrl(serverUrl: string, myPhone: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${base}/app?phone=${encodeURIComponent(myPhone)}`;
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ServerError(`Server said ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
  }
}

/** Tells the server who this phone is and where to send push notifications. */
export function registerDevice(myPhone: string, pushToken: string | null, platform: string) {
  return post('/api/device', { phone: myPhone, pushToken, platform });
}

/** The agent needs the family safe words to check callers. HTTPS only. */
export function uploadSafeWords(myPhone: string, safeWords: SafeWord[]) {
  if (!isHttps(baseUrl())) {
    throw new ServerError('Safe words are only sent over HTTPS. Use an https:// server address.');
  }
  return post('/api/safe-words', {
    phone: myPhone,
    safeWords: safeWords.map(({ name, word }) => ({ name, word })),
  });
}

/** Twilio rings the user's real phone and bridges them into the call. */
export function joinCall(callId: string, myPhone: string) {
  return post(`/api/calls/${encodeURIComponent(callId)}/join`, { phone: myPhone });
}

/** The server hangs up on the caller. */
export function endCall(callId: string) {
  return post(`/api/calls/${encodeURIComponent(callId)}/end`, {});
}

/** Steering: a private instruction for the agent's next line. */
export function steerCall(callId: string, text: string, exact = false) {
  return post(`/api/calls/${encodeURIComponent(callId)}/say`, { text, exact });
}

/** Adds the number to the server's block list. */
export function blockNumber(myPhone: string, number: string, callId?: string) {
  return post('/api/block', { phone: myPhone, number, callId });
}
