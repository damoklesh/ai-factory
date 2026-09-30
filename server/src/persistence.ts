import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LogEntry, RunSnapshot } from "@ai-factory/contracts";

export class PersistenceError extends Error {}

export class AgentPersistence {
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly root = resolve(".agent")) {}

  private async ensure(): Promise<void> { await mkdir(join(this.root, "runs"), { recursive: true }); }
  private async serialized(action: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(action, action);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
  async writeSnapshot(runId: string, snapshot: RunSnapshot): Promise<void> {
    await this.serialized(async () => {
      await this.ensure();
      const path = join(this.root, "runs", runId, "snapshot.json");
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temp, path);
    });
  }
  async readSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    try { return JSON.parse(await readFile(join(this.root, "runs", runId, "snapshot.json"), "utf8")) as RunSnapshot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new PersistenceError(`cannot read snapshot for ${runId}`); }
  }
  async listSnapshots(): Promise<RunSnapshot[]> {
    try {
      const runs = await readdir(join(this.root, "runs"), { withFileTypes: true });
      const snapshots: RunSnapshot[] = [];
      for (const run of runs.filter((entry) => entry.isDirectory())) { const snapshot = await this.readSnapshot(run.name); if (snapshot) snapshots.push(snapshot); }
      return snapshots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new PersistenceError("cannot list run snapshots"); }
  }
  async appendEvent(runId: string, event: LogEntry): Promise<void> {
    await this.serialized(async () => { await this.ensure(); const path = join(this.root, "runs", runId, "events.jsonl"); await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(event)}\n`, "utf8"); });
  }
  async readEvents(runId: string): Promise<LogEntry[]> {
    try {
      const content = await readFile(join(this.root, "runs", runId, "events.jsonl"), "utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
      const events: LogEntry[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        try { events.push(JSON.parse(lines[index]) as LogEntry); }
        catch { if (index === lines.length - 1) break; throw new PersistenceError(`corrupt event record at line ${index + 1}`); }
      }
      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`cannot read events for ${runId}`);
    }
  }
}
