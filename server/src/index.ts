import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, Role } from "../../shared/protocol.ts";
import { CallRoom } from "./room.ts";
import { renderSpeech, ttsEnabled } from "./tts.ts";
import { DeskSession } from "./desk.ts";
import { calls, findCall } from "./call.ts";
import { handleTwilioStream, twiml } from "./twilio.ts";
import { appAllowed, appTokenSet, bearer } from "./auth.ts";
import { streamSig, verifyTwilioRequest } from "./twilioAuth.ts";
import { listCalls, loadCall } from "./store.ts";
import type { DeskClientMsg } from "../../shared/brain.ts";

const PORT = Number(process.env.API_PORT || 8787);
const rooms = new Map<string, CallRoom>();

const http = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true, tts: ttsEnabled(), rooms: rooms.size, calls: [...calls.keys()] });
    }
    // Twilio voice webhook → TwiML that streams the call to /twilio.
    if (req.method === "POST" && req.url?.startsWith("/twilio/voice")) {
      const form = new URLSearchParams(await body(req));
      const host = String(process.env.PUBLIC_HOST || req.headers["x-forwarded-host"] || req.headers.host || "");
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      let sig: string | undefined;
      if (authToken) {
        const hdr = req.headers["x-twilio-signature"];
        const fullUrl = `https://${host}${req.url}`;
        if (!verifyTwilioRequest(authToken, typeof hdr === "string" ? hdr : undefined, fullUrl, form)) {
          return json(res, 403, { error: "invalid twilio signature" });
        }
        sig = streamSig(authToken, form.get("CallSid") || "");
      }
      res.writeHead(200, { "content-type": "text/xml" });
      return res.end(twiml(host, form.get("From") || "unknown", sig));
    }
    if (req.url?.startsWith("/api/calls") && !appAllowed(req, bearer(req))) return json(res, 401, { error: "app token required" });
    if (req.method === "GET" && req.url === "/api/calls") {
      return json(res, 200, listCalls(calls.values()));
    }
    const rev = req.method === "GET" && /^\/api\/calls\/([^/]+)\/review$/.exec(req.url ?? "");
    if (rev) {
      const id = decodeURIComponent(rev[1]);
      const call = findCall(id);
      if (call) return json(res, call.review ? 200 : 202, call.review ?? { pending: true, ended: call.ended });
      const saved = loadCall(id);
      if (saved) return json(res, 200, saved.review);
      return json(res, 404, { error: "no such call" });
    }
    if (req.method === "POST" && req.url === "/api/tts") {
      const { text, voice } = JSON.parse(await body(req)) as { text?: string; voice?: string };
      if (!text || text.length > 600) return json(res, 400, { error: "text required (max 600 chars)" });
      if (!ttsEnabled()) return json(res, 503, { error: "TTS disabled: set GEMINI_API_KEY in .env" });
      const t0 = Date.now();
      const wav = await renderSpeech(text, voice);
      res.writeHead(200, { "content-type": "audio/wav", "x-render-ms": String(Date.now() - t0) });
      return res.end(wav);
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String((err as Error).message || err) });
  }
});

const wss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });
twilioWss.on("connection", handleTwilioStream);
http.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else if (path === "/twilio") twilioWss.handleUpgrade(req, socket, head, (ws) => twilioWss.emit("connection", ws, req));
  else socket.destroy();
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  let room: CallRoom | null = null;
  let role: Role | null = null;
  let desk: DeskSession | null = null;

  ws.on("message", (raw) => {
    let msg: ClientMsg | DeskClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (desk) return desk.handle(msg as DeskClientMsg);
    if (msg.type === "join" && msg.role === "app" && !appAllowed(req, msg.token)) {
      ws.send(JSON.stringify({ type: "error", message: "app token required to join a live call" }));
      return ws.close(4401, "unauthorized");
    }
    if (msg.type === "join" && (msg.role === "desk" || msg.role === "app")) {
      desk = new DeskSession(ws, msg.role, msg.callId);
      console.log(`${msg.role} joined${msg.role === "app" ? ` ${msg.callId}` : ""}`);
      return;
    }
    if (msg.type === "join") {
      if (msg.role !== "alex" && msg.role !== "caller") return;
      room = rooms.get(msg.callId) ?? new CallRoom(msg.callId);
      rooms.set(msg.callId, room);
      role = msg.role;
      room.join(role, ws);
      console.log(`[${msg.callId}] ${role} joined`);
      return;
    }
    if (room && role) room.handle(role, msg as ClientMsg);
  });

  ws.on("close", () => {
    desk?.close();
    if (!room || !role) return;
    room.leave(role, ws);
    console.log(`[${room.callId}] ${role} left`);
    if (room.empty) rooms.delete(room.callId);
  });
});

if (!appTokenSet()) console.warn("APP_TOKEN not set: only this machine can join live calls. Set it before exposing the server.");
http.listen(PORT, () => {
  console.log(`ReVoice server on http://localhost:${PORT}  (tts: ${ttsEnabled() ? "on" : "off, no GEMINI_API_KEY"})`);
  if (!process.env.TWILIO_AUTH_TOKEN) console.warn("Twilio signature check OFF");
});

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 10_000) req.destroy();
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
