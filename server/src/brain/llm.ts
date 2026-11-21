import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

/** One model per lane, as in the architecture diagram. Each can be swapped from .env. */
export const MODELS = {
  flash: process.env.FLASH_MODEL || "gemini-3.5-flash-lite",
  risk: process.env.RISK_MODEL || process.env.FAST_MODEL || "gemini-4-hydrogen",
  notes: process.env.NOTES_MODEL || "gemini-4-hydrogen",
  planner: process.env.PLANNER_MODEL || "gemini-4-argon",
  supervisor: process.env.SUPERVISOR_MODEL || process.env.ANALYST_MODEL || "gemini-4-neon",
  review: process.env.REVIEW_MODEL || "gemini-4-carbon",
};
export type Thinking = "low" | "high" | undefined;
/** "none" in .env means: send no thinking config (for models that don't take one). */
export const thinkingFor = (envName: string, fallback: Thinking): Thinking => {
  const v = process.env[envName];
  return v === "none" ? undefined : (v as Thinking) || fallback;
};

export interface JsonResult<T> {
  ok: boolean;
  data?: T;
  ms: number;
  error?: string;
  retries: number;
}

const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const RETRYABLE_MSG = /\b(?:429|500|503|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL)\b/;
const FETCH_FAILED = /fetch failed/i;

/** True only for transient upstream/network errors; false for aborts, bad JSON, and 4xx client errors. */
export function isRetryable(err: unknown): boolean {
  return checkRetryable(err, 0);
}

function checkRetryable(err: unknown, depth: number): boolean {
  if (err == null || depth > 4) return false;
  if (typeof err === "string") return RETRYABLE_MSG.test(err) || FETCH_FAILED.test(err);
  if (typeof err !== "object") return false;

  const e = err as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    response?: { status?: unknown };
  };
  if (e.name === "AbortError") return false;

  for (const s of [e.status, e.statusCode, e.response?.status]) {
    if (typeof s === "number") {
      if (RETRYABLE_STATUS.has(s)) return true;
      // Non-429 4xx statuses are client errors even if the message happens to mention a number like 500.
      if (s >= 400 && s < 500) return false;
    } else if (typeof s === "string" && RETRYABLE_MSG.test(s)) {
      return true;
    }
  }
  if (typeof e.code === "number" && RETRYABLE_STATUS.has(e.code)) return true;
  if (typeof e.code === "string" && RETRYABLE_MSG.test(e.code)) return true;

  if (typeof e.message === "string" && (RETRYABLE_MSG.test(e.message) || FETCH_FAILED.test(e.message))) return true;
  if (e.cause && e.cause !== err) return checkRetryable(e.cause, depth + 1);
  return false;
}

/** Jittered backoff in [300, 800] ms, slightly longer on the second retry. */
function backoffMs(attempt: number): number {
  const min = attempt === 0 ? 300 : 500;
  const max = attempt === 0 ? 550 : 800;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One JSON-mode call with a hard deadline and bounded retry on transient failures.
 * Never throws: a failure, timeout or bad JSON comes back as ok=false so a lane can
 * simply contribute nothing this turn. All attempts share the single opts.timeoutMs deadline.
 */
export async function generateJson<T>(
  model: string,
  prompt: string,
  opts: { timeoutMs: number; thinking?: "low" | "high"; temperature?: number },
): Promise<JsonResult<T>> {
  const t0 = Date.now();
  // Test seam: scripts/test-learn.ts installs a fake model to run the whole learning loop offline.
  const mock = (globalThis as { __revoiceLlmMock?: (model: string, prompt: string) => unknown }).__revoiceLlmMock;
  if (mock) {
    const data = mock(model, prompt);
    return data && typeof data === "object"
      ? { ok: true, data: data as T, ms: 1, retries: 0 }
      : { ok: false, ms: 1, error: "mock: no answer", retries: 0 };
  }
  if (!ai) return { ok: false, ms: 0, error: "GEMINI_API_KEY not set", retries: 0 };
  const deadline = t0 + opts.timeoutMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  let retries = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            abortSignal: abort.signal,
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.thinking
              ? { thinkingConfig: { thinkingLevel: opts.thinking === "low" ? ThinkingLevel.LOW : ThinkingLevel.HIGH } }
              : {}),
          },
        });
        const text = res.text ?? "";
        try {
          // Abhi's loose parse (unwraps JSON inside extra text), then our guard: lanes read fields off the
          // result, so null, a bare string or a number is as useless as bad JSON.
          const data: unknown = parseLoose(text);
          if (data === null || typeof data !== "object") {
            return { ok: false, ms: Date.now() - t0, error: "model response is not a JSON object or array", retries };
          }
          return { ok: true, data: data as T, ms: Date.now() - t0, retries };
        } catch {
          return { ok: false, ms: Date.now() - t0, error: `bad JSON: ${text.slice(0, 80)}`, retries };
        }
      } catch (e) {
        if (abort.signal.aborted) {
          return { ok: false, ms: Date.now() - t0, error: `timeout after ${opts.timeoutMs} ms`, retries };
        }
        const delay = backoffMs(attempt);
        const canRetry = attempt < MAX_RETRIES && isRetryable(e) && Date.now() + delay < deadline;
        if (!canRetry) {
          const msg = String((e as Error).message || e);
          return { ok: false, ms: Date.now() - t0, error: msg.slice(0, 160), retries };
        }
        // Wait for backoff unless the shared deadline fires first.
        if (!(await sleep(delay, abort.signal))) {
          return { ok: false, ms: Date.now() - t0, error: `timeout after ${opts.timeoutMs} ms`, retries };
        }
        retries++;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** JSON.parse, falling back to the outermost {...} or [...] when the model wraps it in extra text. */
export function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start < 0 || end <= start) throw e;
    return JSON.parse(text.slice(start, end + 1));
  }
}
