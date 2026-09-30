import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";

test("queues an instruction once and applies specification edits only after diff confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-edit-"));
  const backlog = join(root, "backlog");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(backlog));
  await writeFile(join(backlog, "US-1.md"), "---\nstoryId: US-1\ntitle: Sample\n---\n# Sample\n\n## Objective\nOld objective\n", "utf8");
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog });
  const story = (await controller.story("US-1"))!;
  const preview = await controller.updateStorySpec("US-1", { markdown: "# Sample\n\n## Objective\nNew objective\n", expectedRevision: story.specRevision, confirm: false, idempotencyKey: "edit-1" });
  assert.equal(preview.preview, true);
  assert.match(preview.diff, /New objective/);
  assert.match(await readFile(join(backlog, "US-1.md"), "utf8"), /Old objective/);
  const saved = await controller.updateStorySpec("US-1", { markdown: "# Sample\n\n## Objective\nNew objective\n", expectedRevision: story.specRevision, confirm: true, idempotencyKey: "edit-1" });
  assert.equal(saved.preview, false);
  assert.match(await readFile(join(backlog, "US-1.md"), "utf8"), /New objective/);
  await assert.rejects(() => controller.updateStorySpec("US-1", { markdown: "bad", expectedRevision: story.specRevision, confirm: true, idempotencyKey: "edit-2" }), /VERSION_CONFLICT/);
  const run = await controller.start({ maxStories: 1, autoMerge: false });
  const paused = await controller.control(run.runId, "pause");
  const instruction = await controller.addInstruction(run.runId, { content: "Inspect the updated criteria", expectedRunStatus: paused.status, idempotencyKey: "instruction-1" });
  assert.equal(instruction.status, "PENDING_NEXT_INVOCATION");
  assert.deepEqual(await controller.addInstruction(run.runId, { content: "ignored duplicate", expectedRunStatus: paused.status, idempotencyKey: "instruction-1" }), instruction);
});

test("rejects unsafe story identifiers and editing an active story", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-edit-active-"));
  const backlog = join(root, "backlog"); await import("node:fs/promises").then(({ mkdir }) => mkdir(backlog));
  await writeFile(join(backlog, "US-1.md"), "---\nstoryId: US-1\n---\n# Sample", "utf8");
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog });
  const story = (await controller.story("US-1"))!; await controller.start({ maxStories: 1, autoMerge: false });
  await assert.rejects(() => controller.updateStorySpec("US-1", { markdown: "changed", expectedRevision: story.specRevision, confirm: true, idempotencyKey: "active" }), /SPEC_EDIT_REQUIRES_PAUSE/);
  await assert.rejects(() => controller.updateStorySpec("../outside", { markdown: "changed", expectedRevision: "x", confirm: true, idempotencyKey: "unsafe" }), /PERMISSION_DENIED/);
});
