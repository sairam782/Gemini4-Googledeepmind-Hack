// The eval suite: 5 calls in a row with the same caller; each call starts from the playbook the previous
// call's review just updated. Prints a score per call (0-100) and whether each call beat the one before.
//   npx tsx --env-file=../.env scripts/eval-suite.ts                     5 calls, sister-tow, empty playbook
//   npx tsx --env-file=../.env scripts/eval-suite.ts --calls 5 --persona bank-otp
//   npx tsx --env-file=../.env scripts/eval-suite.ts --persona sister-tow,bank-otp --current --promote
// Runs are saved (files or Supabase) and shown on the web dashboard at /evals.
import { runSuite } from "../src/learn/evals.ts";

const args = process.argv.slice(2);
const opt = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const run = await runSuite({
  calls: Number(opt("calls", "5")),
  personas: opt("persona", "sister-tow").split(",").filter(Boolean),
  fresh: !args.includes("--current"),
  promote: args.includes("--promote"),
  log: (l) => console.log(l),
});
console.log(`\n${run.name}: ${run.status}`);
console.log("call  persona            score  change  verdict  high@  check@  money@  grades q/t  critic's own call");
for (const c of run.calls) {
  console.log(
    `${String(c.n).padEnd(6)}${c.persona.padEnd(19)}${String(c.score).padEnd(7)}${(c.delta === null ? "-" : (c.delta >= 0 ? "+" : "") + c.delta).padEnd(8)}${(c.metrics.verdictCorrect ? "right" : "wrong").padEnd(9)}${String(c.metrics.reachedHighAt ?? "-").padEnd(7)}${String(c.metrics.firstCheckAskedAt ?? "-").padEnd(8)}${String(c.metrics.firstMoneyAt ?? "-").padEnd(8)}${`${c.grades.questioning}/${c.grades.timing}`.padEnd(13)}${c.ownVerdict ? `${c.ownVerdict.call} (${Math.round(c.ownVerdict.confidence * 100)}%)` : "-"}`,
  );
}
if (run.result) console.log(`\nfirst ${run.result.first} → last ${run.result.last} (best ${run.result.best}); improved on ${run.result.improvedSteps}/${run.result.steps} steps; ${run.result.passed ? "PASS: ended higher and never dropped" : "NOT YET: see the calls that dropped"}`);
process.exit(run.status === "done" ? 0 : 1);
