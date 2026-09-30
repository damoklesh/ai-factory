import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPersistence, PersistenceError } from "../src/persistence.js";

const event = (sequence: number) => ({ schemaVersion: 1, eventId: `event-${sequence}`, runId: "run-1", sequence, timestamp: new Date().toISOString(), source: "controller" as const, phase: "SELECTING" as const, level: "INFO" as const, message: `event ${sequence}` });

test("persists snapshots and tolerates an incomplete final JSONL line", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-agent-"));
  const persistence = new AgentPersistence(root);
  await persistence.writeSnapshot("run-1", { schemaVersion: 1, runId: "run-1", status: "ACTIVE", phase: "SELECTING", startedAt: "now", updatedAt: "now", attempts: 0, maxStories: 1, autoMerge: false, validationStatus: "PENDING", effectiveConfigRevision: "config-1" });
  await persistence.appendEvent("run-1", event(1));
  await persistence.appendEvent("run-1", event(2));
  await writeFile(join(root, "runs", "run-1", "events.jsonl"), `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n{\"partial\":`, "utf8");
  assert.equal((await persistence.readSnapshot("run-1"))?.runId, "run-1");
  assert.equal((await persistence.readEvents("run-1")).length, 2);
});

test("rejects corruption in the middle of the event log", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-corrupt-"));
  const persistence = new AgentPersistence(root);
  await writeFile(join(root, "runs", "run-1", "events.jsonl"), `${JSON.stringify(event(1))}\nnot-json\n${JSON.stringify(event(2))}\n`, "utf8").catch(async () => { await persistence.appendEvent("run-1", event(1)); await writeFile(join(root, "runs", "run-1", "events.jsonl"), `${JSON.stringify(event(1))}\nnot-json\n${JSON.stringify(event(2))}\n`, "utf8"); });
  await assert.rejects(() => persistence.readEvents("run-1"), PersistenceError);
});

test("redacts secrets and reads large logs page by page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-pages-"));
  const persistence = new AgentPersistence(root);
  for (let sequence = 1; sequence <= 250; sequence += 1) await persistence.appendEvent("run-1", { ...event(sequence), message: sequence === 1 ? "TOKEN=abc123 <b>unsafe</b>\u001b[31m fail" : `event ${sequence}` });
  const first = await persistence.readEventsPage("run-1", { limit: 50 });
  assert.equal(first.entries.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].message, "TOKEN=[REDACTED] unsafe fail");
  const second = await persistence.readEventsPage("run-1", { cursor: first.nextCursor, limit: 50 });
  assert.equal(second.entries[0].sequence, 51);
});
