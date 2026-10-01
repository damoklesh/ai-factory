import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";

test("saves validated config atomically and preserves active run snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-config-"));
  const configPath = join(root, "automation", "config.json");
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { configPath });
  const before = await controller.configView();
  const run = await controller.start({ maxStories: 1, autoMerge: false });
  const saved = await controller.updateConfig({ config: { modelVersion: "gpt-5.6", developerModel: "terra", developerReasoning: "high", reviewerModel: "luna", reviewerReasoning: "low", maxFixCycles: 5, validationCommands: ["npm test"] }, expectedRevision: before.revision, idempotencyKey: "config-1" });
  assert.equal(saved.config.developerModel, "terra");
  assert.equal(saved.config.modelVersion, "gpt-5.6");
  assert.equal(saved.config.reviewerReasoning, "low");
  assert.match(await readFile(configPath, "utf8"), /"developerModel": "terra"/);
  assert.equal((await controller.run(run.runId))?.effectiveConfigRevision, before.revision);
  await assert.rejects(() => controller.updateConfig({ config: { model: "other" }, expectedRevision: before.revision, idempotencyKey: "config-2" }), /VERSION_CONFLICT/);
});
