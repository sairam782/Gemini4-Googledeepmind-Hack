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
}

/**
 * One JSON-mode call with a hard deadline. Never throws: a failure, timeout or bad JSON
 * comes back as ok=false so a lane can simply contribute nothing this turn.
 */
export async function generateJson<T>(
  model: string,
  prompt: string,
  opts: { timeoutMs: number; thinking?: "low" | "high" },
): Promise<JsonResult<T>> {
  const t0 = Date.now();
  // Test seam: scripts/test-learn.ts installs a fake model to run the whole learning loop offline.
  const mock = (globalThis as { __revoiceLlmMock?: (model: string, prompt: string) => unknown }).__revoiceLlmMock;
  if (mock) {
    const data = mock(model, prompt);
    return data && typeof data === "object" ? { ok: true, data: data as T, ms: 1 } : { ok: false, ms: 1, error: "mock: no answer" };
  }
  if (!ai) return { ok: false, ms: 0, error: "GEMINI_API_KEY not set" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        abortSignal: abort.signal,
        ...(opts.thinking
          ? { thinkingConfig: { thinkingLevel: opts.thinking === "low" ? ThinkingLevel.LOW : ThinkingLevel.HIGH } }
          : {}),
      },
    });
    const text = res.text ?? "";
    try {
      const data = JSON.parse(text) as unknown;
      // Lanes read fields off the result; null, a bare string or a number is as useless as bad JSON.
      if (data === null || typeof data !== "object") return { ok: false, ms: Date.now() - t0, error: `not a JSON object: ${text.slice(0, 80)}` };
      return { ok: true, data: data as T, ms: Date.now() - t0 };
    } catch {
      return { ok: false, ms: Date.now() - t0, error: `bad JSON: ${text.slice(0, 80)}` };
    }
  } catch (e) {
    const msg = abort.signal.aborted ? `timeout after ${opts.timeoutMs} ms` : String((e as Error).message || e);
    return { ok: false, ms: Date.now() - t0, error: msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}
