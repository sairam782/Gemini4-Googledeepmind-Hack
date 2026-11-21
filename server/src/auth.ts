import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Who may watch or steer a live phone call. Alex's app holds APP_TOKEN and sends it when joining
 * (WebSocket `join` with role "app") and as `Authorization: Bearer` on /api/calls.
 * Without APP_TOKEN anyone may join (hackathon default: wide open). Set APP_TOKEN to lock it down.
 */
const TOKEN = process.env.APP_TOKEN || "";

export const appTokenSet = () => TOKEN.length > 0;

function isLoopback(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function same(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appAllowed(req: IncomingMessage, token: string | null | undefined) {
  if (!TOKEN) return true; // open by default
  return (typeof token === "string" && same(token, TOKEN)) || isLoopback(req);
}

export function bearer(req: IncomingMessage) {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}
