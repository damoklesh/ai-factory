import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRunLock } from "../src/run-lock.js";

test("serializes project runs and recovers a dead same-host lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-lock-")); const first = new ProjectRunLock(root); await first.acquire("run-1"); const second = new ProjectRunLock(root); await assert.rejects(() => second.acquire("run-2"), /RUN_ALREADY_ACTIVE_FOR_PROJECT/); await first.release("run-1"); await second.acquire("run-2"); await second.release("run-2");
  await writeFile(join(root, "run.lock.json"), JSON.stringify({ runId: "dead", pid: 999999, host: (await import("node:os")).hostname(), acquiredAt: new Date().toISOString() })); await first.acquire("run-recovered"); assert.equal(await first.isLive("run-recovered"), true); await first.release("run-recovered");
});
