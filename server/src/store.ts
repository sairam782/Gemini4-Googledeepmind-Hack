import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallReview } from "../../shared/brain.ts";

export interface SavedCall {
  callId: string;
  from: string;
  startedAt: number;
  endedAt: number;
  review: CallReview;
}

export interface CallSummary {
  callId: string;
  from: string;
  live: boolean;
  startedAt: number;
  endedAt?: number;
  verdict?: CallReview["verdict"];
  finalLevel?: CallReview["finalLevel"];
  locked?: boolean;
}

export interface LiveCallLike {
  id: string;
  from: string;
  ended: boolean;
  startedAt: number;
  endedAt: number | null;
  review: CallReview | null;
}

const DEFAULT_DATA_DIR = resolve(import.meta.dirname, "..", "data");

/** Allow DATA_DIR env override so tests and scripts can isolate storage. */
export function callsDir(): string {
  return join(process.env.DATA_DIR || DEFAULT_DATA_DIR, "calls");
}

/** Sanitize a callId into a flat, traversal-safe filename stem. */
export function safeCallId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

/** Persist a completed call review to <DATA_DIR>/calls/<callId>.json. */
export function saveCall(record: SavedCall): string | null {
  if (process.env.SAVE_CALLS === "0") return null;
  const stem = safeCallId(record.callId);
  if (!stem) return null;
  const dir = callsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stem}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** Load one saved call by callId, returning null if missing or mismatched. */
export function loadCall(callId: string): SavedCall | null {
  const stem = safeCallId(callId);
  if (!stem) return null;
  const file = join(callsDir(), `${stem}.json`);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SavedCall;
    // Guard against sanitized-name collisions (e.g. "a/b" vs "a:b").
    return parsed && parsed.callId === callId ? parsed : null;
  } catch {
    return null;
  }
}

/** Read all saved call files from disk, ignoring missing dir or corrupt entries. */
export function listSavedCalls(): SavedCall[] {
  let names: string[];
  try {
    names = readdirSync(callsDir());
  } catch {
    return [];
  }
  const out: SavedCall[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(callsDir(), name), "utf8")) as SavedCall;
      if (parsed && typeof parsed.callId === "string" && parsed.review) out.push(parsed);
    } catch {
      // Skip unreadable or partially written files so one bad file never breaks listing.
    }
  }
  return out;
}

/** Merge live calls with saved calls on disk, newest first. */
export function listCalls(liveCalls: Iterable<LiveCallLike> = []): CallSummary[] {
  const byId = new Map<string, CallSummary>();
  for (const s of listSavedCalls()) {
    byId.set(s.callId, {
      callId: s.callId,
      from: s.from,
      live: false,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      verdict: s.review.verdict,
      finalLevel: s.review.finalLevel,
      locked: s.review.locked,
    });
  }
  for (const c of liveCalls) {
    const item: CallSummary = {
      callId: c.id,
      from: c.from,
      live: !c.ended,
      startedAt: c.startedAt,
    };
    if (c.endedAt !== null) item.endedAt = c.endedAt;
    if (c.review) {
      item.verdict = c.review.verdict;
      item.finalLevel = c.review.finalLevel;
      item.locked = c.review.locked;
    }
    byId.set(c.id, item);
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}
