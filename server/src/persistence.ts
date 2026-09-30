import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import type { LogEntry, LogPage, RunSnapshot } from "@ai-factory/contracts";

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
    const sanitized = sanitizeLogEntry(event);
    await this.serialized(async () => { await this.ensure(); const path = join(this.root, "runs", runId, "events.jsonl"); await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(sanitized)}\n`, "utf8"); });
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
  async readEventsPage(runId: string, options: { cursor?: number; limit?: number; level?: LogEntry["level"]; source?: LogEntry["source"]; search?: string } = {}): Promise<LogPage> {
    const entries: LogEntry[] = []; const cursor = options.cursor || 0; const limit = Math.min(Math.max(options.limit || 100, 1), 500); const search = options.search?.toLowerCase();
    try {
      const stream = createReadStream(join(this.root, "runs", runId, "events.jsonl"), { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let lastSequence = cursor; let truncated = false;
      try {
        for await (const line of lines) {
          if (!line) continue;
          let event: LogEntry;
          try { event = JSON.parse(line) as LogEntry; } catch { truncated = true; continue; }
          if (event.sequence <= cursor || (options.level && event.level !== options.level) || (options.source && event.source !== options.source) || (search && !event.message.toLowerCase().includes(search))) continue;
          if (entries.length >= limit) { truncated = true; break; }
          entries.push(sanitizeLogEntry(event)); lastSequence = event.sequence;
        }
      } finally { lines.close(); stream.destroy(); }
      return { entries, nextCursor: entries.length ? lastSequence : undefined, hasMore: truncated, truncated: truncated || undefined };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], hasMore: false }; throw new PersistenceError(`cannot read event page for ${runId}`); }
  }
}

export function sanitizeText(value: string): string { return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;\d]{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]").replace(/<[^>]*>/g, ""); }
function sanitizeLogEntry(entry: LogEntry): LogEntry { const message = sanitizeText(entry.message); const command = entry.command ? sanitizeText(entry.command) : undefined; return { ...entry, message, ...(command ? { command } : {}), redacted: entry.redacted || message !== entry.message || command !== entry.command }; }
