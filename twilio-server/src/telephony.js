// Everything specific to the phone provider lives here (SignalWire today).
// To switch back to Twilio: change the cXML/TwiML builders, the REST base URL and auth,
// the signature check, and parseStreamMessage. The rest of the server stays the same.
//
// SignalWire docs:
//   <Connect><Stream>: https://signalwire.com/docs/compatibility-api/cxml/reference/voice/stream
//   Update a call:      https://signalwire.com/docs/compatibility-api/rest/calls/update-a-call
//   Webhook security:   https://signalwire.com/docs/compatibility-api/guides/webhook-security

import { RestClient } from '@signalwire/compatibility-api';

const env = (k) => (process.env[k] || '').trim();
export const PROVIDER = 'signalwire';
export const agentNumber = () => env('SIGNALWIRE_NUMBER');

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;

// ---------------------------------------------------------------- cXML responses

/** Stream the call to wss://<host>/media in both directions. Params arrive in start.customParameters. */
export function streamResponse(host, params) {
  const p = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `      <Parameter name="${esc(k)}" value="${esc(v)}"/>`)
    .join('\n');
  return xml(`  <Connect>\n    <Stream url="wss://${esc(host)}/media">\n${p}\n    </Stream>\n  </Connect>`);
}

/** Blocked caller: reject without answering. */
export const rejectResponse = () => xml('  <Reject reason="rejected"/>');

/** Join: ring the user's real phone and bridge the caller to it. */
export function dialResponse(phone) {
  const callerId = agentNumber();
  return xml(`  <Dial${callerId ? ` callerId="${esc(callerId)}"` : ''}>${esc(phone)}</Dial>`);
}

/** Webhook form fields we use. ForwardedFrom is set by some carriers on forwarded calls. */
export function webhookFields(params) {
  return {
    callSid: params.get('CallSid') || '',
    from: params.get('From') || '',
    to: params.get('To') || '',
    forwardedFrom: params.get('ForwardedFrom') || params.get('Diversion') || '',
    status: params.get('CallStatus') || '',
  };
}

// ---------------------------------------------------------------- signature check

/**
 * SignalWire signs webhooks with the project's Signing Key (Dashboard → API Credentials),
 * sent in x-signalwire-signature. `url` must be the exact public URL SignalWire called.
 */
export function validWebhook(req, url, params) {
  const key = env('SIGNALWIRE_SIGNING_KEY');
  const sig = req.headers['x-signalwire-signature'];
  if (!key || typeof sig !== 'string') return false;
  try {
    return RestClient.validateRequest(key, sig, url, Object.fromEntries(params));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- REST (Compatibility API)

async function updateCall(callSid, fields) {
  const space = (env('SIGNALWIRE_SPACE_URL') || env('SIGNALWIRE_SPACE')).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const project = env('SIGNALWIRE_PROJECT_ID');
  const token = env('SIGNALWIRE_API_TOKEN');
  if (!space || !project || !token) throw new Error('SignalWire credentials are missing in .env');
  const res = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${project}/Calls/${encodeURIComponent(callSid)}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${project}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
  });
  if (!res.ok) throw new Error(`SignalWire ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Hang up the call. */
export const endCall = (callSid) => updateCall(callSid, { Status: 'completed' });

/** Point the live call at new cXML (e.g. the Join <Dial>). */
export const redirectCall = (callSid, url) => updateCall(callSid, { Url: url, Method: 'POST' });

// ---------------------------------------------------------------- media stream messages

/**
 * Normalizes one stream message. Returns null for anything unusable.
 * start: { event, streamSid, callSid, params, encoding, rate }
 * media: { event, payload (Buffer), track }
 * mark:  { event, name }
 */
export function parseStreamMessage(raw) {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!m || typeof m.event !== 'string') return null;
  switch (m.event) {
    case 'start': {
      const s = m.start || {};
      if (typeof s.streamSid !== 'string') return null;
      const fmt = s.mediaFormat || {};
      return {
        event: 'start',
        streamSid: s.streamSid,
        callSid: s.callSid || '',
        params: s.customParameters || {},
        encoding: fmt.encoding || 'audio/x-mulaw',
        rate: Number(fmt.sampleRate) || 8000,
      };
    }
    case 'media':
      if (typeof m.media?.payload !== 'string') return null;
      return { event: 'media', payload: Buffer.from(m.media.payload, 'base64'), track: m.media.track || 'inbound' };
    case 'mark':
      return { event: 'mark', name: m.mark?.name || '' };
    case 'stop':
      return { event: 'stop' };
    default:
      return { event: m.event };
  }
}

export const mediaMessage = (streamSid, payload) =>
  JSON.stringify({ event: 'media', streamSid, media: { payload: payload.toString('base64') } });
export const clearMessage = (streamSid) => JSON.stringify({ event: 'clear', streamSid });
export const markMessage = (streamSid, name) => JSON.stringify({ event: 'mark', streamSid, mark: { name } });
