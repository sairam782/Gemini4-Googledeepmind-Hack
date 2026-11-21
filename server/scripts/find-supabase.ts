// Finds the connection URI for your Supabase project and writes SUPABASE_DB_URL into ../.env.
// Needs SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD in .env. Never prints the password.
//   npx tsx --env-file=../.env scripts/find-supabase.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ref = process.env.SUPABASE_PROJECT_REF;
const pw = process.env.SUPABASE_DB_PASSWORD;
if (!ref || !pw) {
  console.error("Set SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD in .env");
  process.exit(1);
}
const enc = encodeURIComponent(pw);
const regions = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2"];
// Session pooler first (works on IPv4 networks and from most hosts), then the direct host.
const candidates = [
  ...["aws-0", "aws-1"].flatMap((p) => regions.map((r) => `postgresql://postgres.${ref}:${enc}@${p}-${r}.pooler.supabase.com:5432/postgres`)),
  `postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres`,
];
const hide = (u: string) => u.replace(enc, "****");

async function tryOne(url: string): Promise<string | null> {
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 6, idle_timeout: 1, onnotice: () => {} });
  try {
    const [r] = await sql<{ v: string }[]>`select current_setting('server_version') as v`;
    return r.v;
  } catch (e) {
    const m = String((e as Error).message || e);
    if (!/tenant|not found|ENOTFOUND|getaddrinfo/i.test(m)) console.log(`  ${hide(url)}: ${m.slice(0, 120)}`);
    return null;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

// Probe in small batches so the right host answers fast without opening dozens of sockets.
let found: string | null = null;
for (let i = 0; i < candidates.length && !found; i += 6) {
  const batch = candidates.slice(i, i + 6);
  const res = await Promise.all(batch.map(async (u) => ({ u, v: await tryOne(u) })));
  const hit = res.find((x) => x.v);
  if (hit) {
    found = hit.u;
    console.log(`Connected: ${hide(hit.u)} (Postgres ${hit.v})`);
  }
}
if (!found) {
  console.error("No host accepted the connection. Check the password (Project Settings → Database) and the project ref.");
  process.exit(1);
}
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
let env = readFileSync(envPath, "utf8");
env = /^SUPABASE_DB_URL=.*$/m.test(env) ? env.replace(/^SUPABASE_DB_URL=.*$/m, `SUPABASE_DB_URL=${found}`) : `${env.trimEnd()}\nSUPABASE_DB_URL=${found}\n`;
writeFileSync(envPath, env);
console.log("Wrote SUPABASE_DB_URL to .env");
process.exit(0);
