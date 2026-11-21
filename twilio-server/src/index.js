// Uno ReVoice phone server.
//
//   Caller → carrier forwarding → SignalWire number → POST /voice → <Connect><Stream> → WS /media
//   WS /media:  caller audio (8 kHz µ-law) → 16 kHz PCM → Gemini Live agent → 24 kHz PCM → 8 kHz µ-law back
//   brain.js:   warning signs (gemini-4-hydrogen) and verdict (gemini-4-neon) from the transcript
//   WS /app:    events to the phone app; HTTP /api/... from the app (join, end, block, say, device)

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { startAgent } from './agent.js';
import { decodeMulaw, encodeMulaw, pcmBytes, pcmFromBytes, resample } from './audio.js';
import { createBrain } from './brain.js';
import { addApp, block, calls, emit, endCall, isBlocked, nextTurn, ownerPhone, saveDevice, startCall } from './calls.js';
import * as tel from './telephony.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const VALIDATE = process.env.VALIDATE_SIGNATURE === 'true';
const FRAME = 160; // 20 ms of 8 kHz µ-law

const host = (req) => PUBLIC_HOST || req.headers['x-forwarded-host'] || req.headers.host || '';

// ---------------------------------------------------------------- HTTP helpers

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 20_000) req.destroy();
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const send = (res, status, type, data) => {
  res.writeHead(status, { 'content-type': type });
  res.end(data);
};
const json = (res, status, data) => send(res, status, 'application/json', JSON.stringify(data));
const cxml = (res, data) => send(res, 200, 'text/xml', data);

/** Webhook form params, with the signature check when VALIDATE_SIGNATURE=true. */
async function webhook(req, res) {
  const params = new URLSearchParams(await body(req));
  if (VALIDATE && !tel.validWebhook(req, `https://${host(req)}${req.url}`, params)) {
    send(res, 403, 'text/plain', 'bad signature');
    return null;
  }
  return params;
}

// ---------------------------------------------------------------- routes

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/') return send(res, 200, 'text/plain', 'Uno ReVoice phone server is running.');
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, provider: tel.PROVIDER, calls: [...calls.keys()], owner: ownerPhone() ? 'set' : 'none' });
    }

    // A call reached the agent's number.
    if (req.method === 'POST' && path === '/voice') {
      const p = await webhook(req, res);
      if (!p) return;
      const w = tel.webhookFields(p);
      if (isBlocked(w.from)) {
        console.log(`[voice] rejected blocked caller ${w.from}`);
        return cxml(res, tel.rejectResponse());
      }
      const owner = ownerPhone() || w.forwardedFrom;
      console.log(`[voice] call ${w.callSid} from ${w.from || 'unknown'}${w.forwardedFrom ? ` (forwarded from ${w.forwardedFrom})` : ''}`);
      return cxml(res, tel.streamResponse(host(req), { callId: w.callSid, from: w.from, userPhone: owner }));
    }

    // Call status changes (set as the number's Status Change Webhook).
    if (req.method === 'POST' && path === '/voice/status') {
      const p = await webhook(req, res);
      if (!p) return;
      const w = tel.webhookFields(p);
      if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(w.status)) {
        await endCall(calls.get(w.callSid), `status ${w.status}`);
      }
      return send(res, 204, 'text/plain', '');
    }

    // Join: the call is redirected here, and we ring the user's phone.
    if (req.method === 'POST' && path === '/voice/join') {
      const p = await webhook(req, res);
      if (!p) return;
      const phone = url.searchParams.get('phone') || ownerPhone();
      return cxml(res, tel.dialResponse(phone));
    }

    if (req.method === 'POST' && path === '/api/device') {
      const { phone, pushToken, platform } = JSON.parse((await body(req)) || '{}');
      if (!phone) return json(res, 400, { error: 'phone required' });
      saveDevice(phone, pushToken, platform);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/block') {
      const { number, callId } = JSON.parse((await body(req)) || '{}');
      block(number);
      console.log(`[block] ${number}${callId ? ` (call ${callId})` : ''}`);
      return json(res, 200, { ok: true });
    }

    const m = /^\/api\/calls\/([^/]+)\/(join|end|say)$/.exec(path);
    if (req.method === 'POST' && m) {
      const call = calls.get(decodeURIComponent(m[1]));
      if (!call || call.ended) return json(res, 404, { error: 'no live call with that id' });
      const data = JSON.parse((await body(req)) || '{}');

      if (m[2] === 'say') {
        if (!data.text?.trim()) return json(res, 400, { error: 'text required' });
        if (!call.agent || call.joined) return json(res, 409, { error: 'the agent is not on this call' });
        call.agent.steer(data.text.trim().slice(0, 300));
        console.log(`[call ${call.callId}] steer: ${data.text}`);
        return json(res, 200, { ok: true });
      }

      if (m[2] === 'end') {
        await tel.endCall(call.callId);
        await endCall(call, 'ended from the app');
        return json(res, 200, { ok: true });
      }

      // join
      const phone = data.phone || ownerPhone();
      if (!phone) return json(res, 400, { error: 'phone required' });
      if (!PUBLIC_HOST) return json(res, 500, { error: 'PUBLIC_HOST is not set' });
      call.joined = true;
      call.agent?.close();
      call.agent = null;
      call.clear?.();
      await tel.redirectCall(call.callId, `https://${PUBLIC_HOST}/voice/join?phone=${encodeURIComponent(phone)}`);
      console.log(`[call ${call.callId}] joined: ringing ${phone}`);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------- WebSockets

const mediaWss = new WebSocketServer({ noServer: true });
const appWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/media') mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit('connection', ws, req));
  else if (path === '/app') appWss.handleUpgrade(req, socket, head, (ws) => appWss.emit('connection', ws, req));
  else socket.destroy();
});

appWss.on('connection', (ws, req) => {
  const phone = new URL(req.url || '/', 'http://x').searchParams.get('phone') || '';
  addApp(ws, phone);
  console.log(`[app] connected${phone ? ` (${phone})` : ''}`);
});

/** One SignalWire media stream ↔ one Gemini Live agent. */
mediaWss.on('connection', (ws) => {
  let call = null;
  let streamSid = '';
  let inFormat = { encoding: 'audio/x-mulaw', rate: 8000 };

  const toLine = (m) => ws.readyState === ws.OPEN && ws.send(m);

  // Agent audio (PCM16 at `rate`) → the call's format, in 20 ms frames.
  const play = (pcmBuf, rate) => {
    const pcm = pcmFromBytes(pcmBuf);
    if (inFormat.encoding === 'audio/x-mulaw') {
      const ulaw = encodeMulaw(resample(pcm, rate, 8000));
      for (let i = 0; i < ulaw.length; i += FRAME) toLine(tel.mediaMessage(streamSid, ulaw.subarray(i, i + FRAME)));
    } else {
      toLine(tel.mediaMessage(streamSid, pcmBytes(resample(pcm, rate, inFormat.rate))));
    }
  };

  ws.on('message', (raw) => {
    const m = tel.parseStreamMessage(raw);
    if (!m) return;

    if (m.event === 'start' && !call) {
      streamSid = m.streamSid;
      inFormat = { encoding: m.encoding, rate: m.rate };
      const callId = m.params.callId || m.callSid || streamSid;
      call = startCall(callId, m.params.from || '', m.params.userPhone || ownerPhone());
      call.clear = () => toLine(tel.clearMessage(streamSid));
      const c = call;
      console.log(`[media] stream ${streamSid} for call ${callId} (${m.encoding} ${m.rate} Hz)`);

      c.brain = createBrain((e) => emit(c, e));
      const line = (speaker, text) => {
        const turn = nextTurn(c);
        emit(c, { type: 'transcript', turn, speaker, text });
        c.brain.onLine(speaker, text, turn);
      };
      c.agent = startAgent({
        onAudio: play,
        onInterrupted: () => toLine(tel.clearMessage(streamSid)),
        onCallerLine: (t) => line('caller', t),
        onAgentLine: (t) => line('agent', t),
        onError: (msg) => console.warn(`[call ${callId}] ${msg}`),
      });
      return;
    }

    if (m.event === 'media' && call?.agent && m.track !== 'outbound') {
      const pcm = m.payload && inFormat.encoding === 'audio/x-mulaw' ? decodeMulaw(m.payload) : pcmFromBytes(m.payload);
      call.agent.sendAudio(pcmBytes(resample(pcm, inFormat.encoding === 'audio/x-mulaw' ? 8000 : inFormat.rate, 16000)));
      return;
    }

    if (m.event === 'stop' && call && !call.joined) void endCall(call, 'stream stopped');
  });

  ws.on('close', () => {
    // After Join the stream closes but the call goes on (bridged to the user); status webhook ends it.
    if (call && !call.joined) void endCall(call, 'stream closed');
  });
});

server.listen(PORT, () => {
  console.log(`Uno ReVoice phone server on http://localhost:${PORT} (${tel.PROVIDER})`);
  if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY is not set: the agent cannot answer calls.');
  if (!PUBLIC_HOST) console.warn('PUBLIC_HOST is not set: set it to your ngrok host for real calls and Join.');
  else console.log(`SignalWire webhook: https://${PUBLIC_HOST}/voice   status: https://${PUBLIC_HOST}/voice/status`);
  if (!VALIDATE) console.warn('Webhook signature check is OFF (VALIDATE_SIGNATURE=false).');
});
