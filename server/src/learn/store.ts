import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallRecord, CriticReport, JudgeMetrics, Playbook } from "./types.ts";

/** One reviewed call as it's stored: what happened, the numbers, and the critic's notes. */
export interface StoredCall {
  record: CallRecord;
  metrics: JudgeMetrics;
  critic: CriticReport | null;
}

/**
 * Where the review phase keeps its memory. Today: JSON files under server/data/learning.
 * The interface is the seam for a database later (e.g. Supabase Postgres): swap the class, keep the calls.
 */
export interface LearningStore {
  currentPlaybook(): Playbook;
  playbook(version: number): Playbook | null;
  /** Saves a new version and makes it current. */
  savePlaybook(pb: Playbook): void;
  /** Point "current" at an older version (rollback). */
  setCurrent(version: number): void;
  saveCall(c: StoredCall): void;
  calls(): StoredCall[];
  saveRun(name: string, data: unknown): void;
}

export const EMPTY_PLAYBOOK: Playbook = { version: 0, updatedAt: new Date(0).toISOString(), lessons: [], changelog: [{ version: 0, at: new Date(0).toISOString(), note: "empty playbook" }] };

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

  savePlaybook(pb: Playbook) {
    this.write(this.pbPath(pb.version), pb);
    this.setCurrent(pb.version);
  }

  setCurrent(version: number) {
    if (version !== 0 && !existsSync(this.pbPath(version))) throw new Error(`no playbook v${version}`);
    this.write(join(this.dir, "playbook", "current.json"), { version });
  }

  /** Highest version on disk, so a rejected candidate never reuses a number. */
  latestVersion(): number {
    return readdirSync(join(this.dir, "playbook"))
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .reduce((m, v) => Math.max(m, Number(v)), 0);
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
}

const defaultDir = process.env.LEARNING_DIR || fileURLToPath(new URL("../../data/learning/", import.meta.url));
let store: FileStore | null = null;
export const learningStore = (): FileStore => (store ??= new FileStore(defaultDir));
