import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the built web app (web/dist, from `npm run build`) from the API server, so one process on one
 * port is the whole app: easy to deploy and share. Unknown paths fall back to index.html (client routes).
 */
const dist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json",
};

export const webBuilt = () => existsSync(join(dist, "index.html"));

export function serveWeb(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!webBuilt()) return false;
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (path.startsWith("/api/") || path.startsWith("/twilio")) return false;
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) return false; // no climbing out of dist
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  // Hashed assets never change; the HTML always revalidates so a new deploy shows up at once.
  res.writeHead(200, { "content-type": type, "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  if (req.method === "HEAD") return res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}
