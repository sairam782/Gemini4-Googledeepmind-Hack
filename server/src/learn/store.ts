import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_PLAYBOOK } from "./playbook.ts";
import { SupabaseStore } from "./supabase.ts";
import type { CallRecord, CriticReport, JudgeMetrics, Playbook } from "./types.ts";

export { EMPTY_PLAYBOOK };

/** One reviewed call as it's stored: what happened, the numbers, and the critic's notes. */
export interface StoredCall {
  record: CallRecord;
  metrics: JudgeMetrics;
  critic: CriticReport | null;
}

type StoreResult<T> = T | Promise<T>;

/** The file backend is synchronous. The Supabase backend performs the same operations over SQL. */
export interface LearningStore {
  currentPlaybook(): StoreResult<Playbook>;
  playbook(version: number): StoreResult<Playbook | null>;
  latestVersion(): StoreResult<number>;
  /** Publish a version only if its base is still current. */
  savePlaybook(pb: Playbook, expectedVersion: number): StoreResult<boolean>;
  /** Point current at an older version, optionally checking the current version first. */
  setCurrent(version: number, expectedVersion?: number): StoreResult<boolean>;
  saveCall(c: StoredCall): StoreResult<void>;
  calls(): StoreResult<StoredCall[]>;
  saveRun(name: string, data: unknown): StoreResult<void>;
  /** Saved runs whose name starts with `prefix` (e.g. "suite-"), newest first. */
  runs(prefix?: string): StoreResult<{ name: string; data: unknown }[]>;
}

export class FileStore implements LearningStore {
  constructor(readonly dir: string) {
    for (const d of ["playbook", "calls", "runs"]) mkdirSync(join(dir, d), { recursive: true });
  }

  private read<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Write to a temp file and rename, so a crash mid-write never leaves half a JSON file. */
  private write(path: string, data: unknown) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  private pbPath(v: number) {
    return join(this.dir, "playbook", `v${String(v).padStart(3, "0")}.json`);
  }

  currentPlaybook(): Playbook {
    const cur = this.read<{ version: number }>(join(this.dir, "playbook", "current.json"));
    return (cur && this.playbook(cur.version)) || structuredClone(EMPTY_PLAYBOOK);
  }

  playbook(version: number): Playbook | null {
    if (version === 0) return structuredClone(EMPTY_PLAYBOOK);
    return this.read<Playbook>(this.pbPath(version));
  }

  savePlaybook(pb: Playbook, expectedVersion: number) {
    if (this.currentPlaybook().version !== expectedVersion || existsSync(this.pbPath(pb.version))) return false;
    this.write(this.pbPath(pb.version), pb);
    return this.setCurrent(pb.version);
  }

  setCurrent(version: number, expectedVersion?: number) {
    if (expectedVersion !== undefined && this.currentPlaybook().version !== expectedVersion) return false;
    if (version !== 0 && !existsSync(this.pbPath(version))) throw new Error(`no playbook v${version}`);
    this.write(join(this.dir, "playbook", "current.json"), { version });
    return true;
  }

  private versions(): number[] {
    return readdirSync(join(this.dir, "playbook"))
      .flatMap((file) => {
        const match = /^v(\d+)\.json$/.exec(file);
        return match ? [Number(match[1])] : [];
      });
  }

  /** Highest version on disk, so a rejected candidate never reuses a number. */
  latestVersion(): number {
    return this.versions().reduce((latest, version) => Math.max(latest, version), 0);
  }

  saveCall(c: StoredCall) {
    const safe = c.record.callId.replace(/[^\w.-]/g, "_");
    this.write(join(this.dir, "calls", `${safe}.json`), c);
  }

  calls(): StoredCall[] {
    return readdirSync(join(this.dir, "calls"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.read<StoredCall>(join(this.dir, "calls", f)))
      .filter((c): c is StoredCall => !!c);
  }

  saveRun(name: string, data: unknown) {
    this.write(join(this.dir, "runs", `${name.replace(/[^\w.-]/g, "_")}.json`), data);
  }

  runs(prefix = "") {
    const dir = join(this.dir, "runs");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
      .sort()
      .reverse()
      .map((f) => ({ name: f.slice(0, -5), data: this.read<unknown>(join(dir, f)) }));
  }

  history() {
    const playbooks = this.versions().map((version) => {
      const playbook = this.playbook(version);
      if (!playbook || playbook.version !== version) throw new Error(`Invalid local playbook v${version}`);
      return playbook;
    });
    const dir = join(this.dir, "runs");
    const runs = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ name: file.slice(0, -5), data: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown }));
    return { currentVersion: this.currentPlaybook().version, playbooks, calls: this.calls(), runs };
  }
}

export const localLearningDir = process.env.LEARNING_DIR || fileURLToPath(new URL("../../data/learning/", import.meta.url));
let store: LearningStore | null = null;

export function learningStore(): LearningStore {
  const url = process.env.SUPABASE_DB_URL;
  return (store ??= url ? new SupabaseStore(url) : new FileStore(localLearningDir));
}
