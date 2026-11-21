import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Supabase signs its Postgres certificates with its own root CA, which Node doesn't trust out of the box.
 * Full verification needs that CA: Project Settings → Database → SSL configuration → Download certificate.
 * SUPABASE_CA_CERT may be a file path or the PEM itself (handy on hosting platforms); otherwise the
 * certificate committed at supabase/prod-ca-2021.crt is used. Without either, it still connects over TLS
 * but skips the certificate check (hackathon mode: never fail to connect).
 */
function supabaseCa(): string | undefined {
  const v = process.env.SUPABASE_CA_CERT?.trim();
  if (v) return v.includes("BEGIN CERTIFICATE") ? v.replace(/\\n/g, "\n") : readFileSync(v, "utf8");
  const bundled = fileURLToPath(new URL("../../../supabase/prod-ca-2021.crt", import.meta.url));
  return existsSync(bundled) ? readFileSync(bundled, "utf8") : undefined;
}
import { EMPTY_PLAYBOOK } from "./playbook.ts";
import type { LearningStore, StoredCall } from "./store.ts";
import type { Playbook } from "./types.ts";

type Queries = postgres.Sql | postgres.TransactionSql;

export class SupabaseStore implements LearningStore {
  private sql: postgres.Sql;

  constructor(connectionString: string) {
    if (!URL.canParse(connectionString)) throw new Error("SUPABASE_DB_URL is not a valid Postgres URI");
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("SUPABASE_DB_URL must use the postgres or postgresql scheme");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    this.sql = postgres(connectionString, {
      ssl: local && url.searchParams.get("sslmode") === "disable" ? false : ((ca) => (ca ? { ca, rejectUnauthorized: true } : "verify-full"))(supabaseCa()),
      prepare: false,
      max: 5,
      connect_timeout: 15, // a cold pooler + TLS handshake can take a few seconds
      idle_timeout: 20,
    });
  }

  async migrate(): Promise<void> {
    const migration = new URL("../../../supabase/migrations/20261121190000_learning_store.sql", import.meta.url);
    await this.sql.begin(async (tx) => {
      await tx.file(fileURLToPath(migration)).simple();
    });
  }

  async currentPlaybook(): Promise<Playbook> {
    const [row] = await this.sql<{ document: Playbook | null }[]>`
      select pb.document
      from revoice.current_playbook current
      left join revoice.playbooks pb on pb.version = current.version
      where current.singleton
    `;
    return row.document ?? structuredClone(EMPTY_PLAYBOOK);
  }

  async playbook(version: number): Promise<Playbook | null> {
    if (version === 0) return structuredClone(EMPTY_PLAYBOOK);
    const [row] = await this.sql<{ document: Playbook }[]>`
      select document from revoice.playbooks where version = ${version}
    `;
    return row?.document ?? null;
  }

  async latestVersion(): Promise<number> {
    const [row] = await this.sql<{ version: number }[]>`
      select coalesce(max(version), 0) as version from revoice.playbooks
    `;
    return row.version;
  }

  async savePlaybook(playbook: Playbook, expectedVersion: number): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [current] = await tx<{ version: number | null }[]>`
        select version from revoice.current_playbook where singleton for update
      `;
      if ((current.version ?? 0) !== expectedVersion) return false;

      const inserted = await tx`
        insert into revoice.playbooks (version, document)
        values (${playbook.version}, ${JSON.stringify(playbook)}::text::jsonb)
        on conflict (version) do nothing returning version
      `;
      if (!inserted.length) return false;
      await this.writeCurrent(tx, playbook.version);
      return true;
    });
  }

  async setCurrent(version: number, expectedVersion?: number): Promise<boolean> {
    const updated = await this.sql`
      update revoice.current_playbook
      set version = ${version || null}
      where singleton and (
        ${expectedVersion === undefined} or coalesce(revoice.current_playbook.version, 0) = ${expectedVersion ?? 0}
      )
      returning version
    `;
    return updated.length > 0;
  }

  private async writeCurrent(sql: Queries, version: number) {
    await sql`update revoice.current_playbook set version = ${version || null} where singleton`;
  }

  async saveCall(call: StoredCall): Promise<void> {
    await this.writeCall(this.sql, call);
  }

  // Send pre-serialized JSON as text so Postgres.js does not encode it again as a JSON string.
  private async writeCall(sql: Queries, { record, metrics, critic }: StoredCall) {
    await sql`
      insert into revoice.calls (call_id, label, playbook_version, ended_at, record, metrics, critic)
      values (${record.callId}, ${record.label}, ${record.playbookVersion}, ${record.endedAt},
        ${JSON.stringify(record)}::text::jsonb, ${JSON.stringify(metrics)}::text::jsonb,
        ${critic ? JSON.stringify(critic) : null}::text::jsonb)
      on conflict (call_id) do update set
        label = excluded.label, playbook_version = excluded.playbook_version,
        ended_at = excluded.ended_at, record = excluded.record, metrics = excluded.metrics, critic = excluded.critic
    `;
  }

  async calls(): Promise<StoredCall[]> {
    return this.sql<StoredCall[]>`select record, metrics, critic from revoice.calls order by call_id`;
  }

  async runs(prefix = ""): Promise<{ name: string; data: unknown }[]> {
    const rows = await this.sql<{ name: string; result: unknown }[]>`
      select name, result from revoice.eval_runs where name like ${prefix.replace(/[%_]/g, "\\$&") + "%"} order by name desc limit 50
    `;
    return rows.map((r) => ({ name: r.name, data: r.result }));
  }

  async saveRun(name: string, data: unknown): Promise<void> {
    await this.writeRun(this.sql, name, data);
  }

  private async writeRun(sql: Queries, name: string, data: unknown) {
    await sql`
      insert into revoice.eval_runs (name, result) values (${name}, ${JSON.stringify(data)}::text::jsonb)
      on conflict (name) do update set result = excluded.result
    `;
  }

  /** Seed an empty database atomically without overwriting a deployment's history. */
  async importHistory(data: { playbooks: Playbook[]; currentVersion: number; calls: StoredCall[]; runs: { name: string; data: unknown }[] }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`lock table revoice.current_playbook in exclusive mode`;
      await tx`lock table revoice.playbooks, revoice.calls, revoice.eval_runs in share row exclusive mode`;
      const [state] = await tx<{ populated: boolean }[]>`
        select exists (select 1 from revoice.playbooks)
          or exists (select 1 from revoice.calls)
          or exists (select 1 from revoice.eval_runs) as populated
      `;
      if (state.populated) throw new Error("Supabase already has learning history. Use an empty learning database for the import.");
      for (const playbook of data.playbooks) {
        await tx`insert into revoice.playbooks (version, document) values (${playbook.version}, ${JSON.stringify(playbook)}::text::jsonb)`;
      }
      for (const call of data.calls) await this.writeCall(tx, call);
      for (const run of data.runs) await this.writeRun(tx, run.name, run.data);
      await this.writeCurrent(tx, data.currentVersion);
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
