import { hostname } from "node:os";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockRecord { runId: string; pid: number; host: string; acquiredAt: string; }

export class ProjectRunLock {
  private readonly path: string;
  constructor(private readonly root: string, private readonly staleAfterMs = 24 * 60 * 60 * 1000) { this.path = join(root, "run.lock.json"); }
  async acquire(runId: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const handle = await open(this.path, "wx"); await handle.writeFile(`${JSON.stringify({ runId, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() } satisfies LockRecord)}\n`, "utf8"); await handle.close(); return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const current = await this.read();
    if (current && await this.ownerIsLive(current)) throw new Error("RUN_ALREADY_ACTIVE_FOR_PROJECT");
    if (current && current.host !== hostname() && Date.now() - Date.parse(current.acquiredAt) < this.staleAfterMs) throw new Error("RUN_LOCK_RECOVERY_REQUIRED");
    await unlink(this.path).catch(() => undefined);
    const handle = await open(this.path, "wx"); await handle.writeFile(`${JSON.stringify({ runId, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() } satisfies LockRecord)}\n`, "utf8"); await handle.close();
  }
  async release(runId: string): Promise<void> { const current = await this.read(); if (current?.runId === runId && current.pid === process.pid && current.host === hostname()) await unlink(this.path).catch(() => undefined); }
  async isLive(runId?: string): Promise<boolean> { const current = await this.read(); return Boolean(current && (!runId || current.runId === runId) && await this.ownerIsLive(current)); }
  private async read(): Promise<LockRecord | undefined> { try { return JSON.parse(await readFile(this.path, "utf8")) as LockRecord; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; } }
  private async ownerIsLive(record: LockRecord): Promise<boolean> { if (record.host !== hostname()) return Date.now() - Date.parse(record.acquiredAt) < this.staleAfterMs; try { process.kill(record.pid, 0); return true; } catch { return false; } }
}
