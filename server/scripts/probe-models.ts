// Checks every model the app uses: does the ID exist for this key, does the thinking setting work, how fast?
//   npx tsx --env-file=../.env scripts/probe-models.ts
import { generateJson, MODELS, thinkingFor } from "../src/brain/llm.ts";
import { CRITIC_MODEL } from "../src/learn/critic.ts";
import { SIM_CALLER_MODEL } from "../src/learn/simulate.ts";

const jobs: { lane: string; model: string; thinking: "low" | "high" | undefined }[] = [
  { lane: "flash", model: MODELS.flash, thinking: thinkingFor("FLASH_THINKING", undefined) },
  { lane: "risk", model: MODELS.risk, thinking: thinkingFor("RISK_THINKING", "low") },
  { lane: "notes", model: MODELS.notes, thinking: thinkingFor("NOTES_THINKING", "low") },
  { lane: "planner", model: MODELS.planner, thinking: thinkingFor("PLANNER_THINKING", "low") },
  { lane: "supervisor", model: MODELS.supervisor, thinking: thinkingFor("SUPERVISOR_THINKING", "low") },
  { lane: "review", model: MODELS.review, thinking: thinkingFor("REVIEW_THINKING", "low") },
  { lane: "critic", model: CRITIC_MODEL, thinking: thinkingFor("CRITIC_THINKING", "high") },
  { lane: "sim-caller", model: SIM_CALLER_MODEL, thinking: thinkingFor("SIM_CALLER_THINKING", "low") },
  // alternatives worth knowing about
  { lane: "critic-alt", model: "gemini-4-carbon", thinking: "high" },
];
const prompt = 'Return JSON only: {"ok":true,"model":"<your name>"}';
const results = await Promise.all(jobs.map(async (j) => ({ ...j, r: await generateJson<{ ok?: boolean }>(j.model, prompt, { timeoutMs: 90000, thinking: j.thinking }) })));
for (const { lane, model, thinking, r } of results)
  console.log(`${r.ok ? "OK  " : "FAIL"} ${lane.padEnd(11)} ${model.padEnd(28)} thinking=${String(thinking ?? "none").padEnd(5)} ${String(r.ms).padStart(6)} ms  ${r.ok ? JSON.stringify(r.data) : r.error}`);
process.exit(results.some((x) => !x.r.ok && x.lane !== "critic-alt") ? 1 : 0);
