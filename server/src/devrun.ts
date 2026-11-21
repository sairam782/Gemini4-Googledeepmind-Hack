import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dev-only: start one of the server's own test scripts and stream its output to a log file,
 * so a run can be kicked off from the browser (the desk) and read back later.
 * Open to anyone (hackathon mode), but only these scripts and only simple flags. DEV_RUNNER=0 turns it off.
 */
const SCRIPTS = new Set(["probe-models.ts", "test-learn.ts", "learn.ts", "replay.ts", "learning-db.ts", "find-supabase.ts", "eval-suite.ts"]);
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const logDir = join(serverDir, "data", "learning", "runs");
const runs = new Map<string, { script: string; args: string[]; startedAt: string; done: boolean; code: number | null; log: string }>();

export const devRunnerOn = () => process.env.DEV_RUNNER !== "0";
export const isLocal = (addr: string | undefined) => !!addr && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr);

export function startRun(script: string, args: unknown): { id?: string; error?: string } {
  if (!SCRIPTS.has(script)) return { error: `script must be one of ${[...SCRIPTS].join(", ")}` };
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list.some((a) => !/^[\w.-]{1,40}$/.test(a))) return { error: "args may only be simple flags and words" };
  mkdirSync(logDir, { recursive: true });
  const id = `${script.replace(/\.ts$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const log = join(logDir, `${id}.log`);
  const out = createWriteStream(log);
  // The test script stays offline on purpose (no key); the others get the .env.
  const env = script === "test-learn.ts" ? { ...process.env, GEMINI_API_KEY: "" } : process.env;
  // Re-read ../.env for every run, so a value added after the server started is picked up.
  // (Variables already set in the environment win, which keeps the test script's blank key blank.)
  const child = spawn(process.execPath, ["--env-file-if-exists=../.env", "--import", "tsx", join("scripts", script), ...list], { cwd: serverDir, env });
  const run = { script, args: list, startedAt: new Date().toISOString(), done: false, code: null as number | null, log };
  runs.set(id, run);
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on("close", (code) => {
    run.done = true;
    run.code = code;
    out.end(`\n[exit ${code}]\n`);
  });
  return { id };
}

export function runStatus(id: string) {
  const r = runs.get(id);
  if (!r) return null;
  const text = existsSync(r.log) ? readFileSync(r.log, "utf8") : "";
  return { ...r, tail: text.slice(-20000) };
}

export const listRuns = () => [...runs.entries()].map(([id, r]) => ({ id, script: r.script, args: r.args, startedAt: r.startedAt, done: r.done, code: r.code }));
