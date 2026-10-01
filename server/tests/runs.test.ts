import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";

test("pause is a request, resume is explicit, and restart marks active work interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-runs-"));
  const persistence = new AgentPersistence(root);
  const first = new LocalController(persistence);
  const started = await first.start({ maxStories: 1, autoMerge: false });
  const requested = await first.control(started.runId, "pause");
  assert.equal(requested.status, "PAUSE_REQUESTED");
  assert.equal((await first.project()).activeRunId, started.runId);
  const restarted = new LocalController(persistence);
  const project = await restarted.project();
  assert.equal(project.activeRunId, undefined);
  const history = await restarted.runs();
  assert.equal(history[0].status, "INTERRUPTED");
  assert.match(history[0].interruptionReason || "", /restarted/);
  const resumed = await restarted.control(started.runId, "resume");
  assert.equal(resumed.status, "ACTIVE");
});

test("event replay returns persisted events after the requested cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-events-"));
  const controller = new LocalController(new AgentPersistence(root));
  const run = await controller.start({ maxStories: 1, autoMerge: false });
  await controller.control(run.runId, "pause");
  const replay = await controller.eventsSince(1);
  assert.equal(replay.length, 2);
  assert.match(replay[1].message, /pause/);
});
