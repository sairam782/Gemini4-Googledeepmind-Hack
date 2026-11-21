import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export const MODELS = {
  fast: process.env.FAST_MODEL || "gemini-4-hydrogen",
  planner: process.env.PLANNER_MODEL || "gemini-4-hydrogen",
  analyst: process.env.ANALYST_MODEL || "gemini-4-neon",
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
      return { ok: true, data: JSON.parse(text) as T, ms: Date.now() - t0 };
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
