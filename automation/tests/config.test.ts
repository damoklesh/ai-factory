import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ensureTargetRepository } from "../src/git.js";
import { parseArgs } from "../src/orchestrator.js";

test("normalizes target repository configuration and keeps legacy owner/repo support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-config-"));
  try {
    const targetConfig = join(directory, "target.json");
    await writeFile(targetConfig, JSON.stringify({ targetRepository: "acme/revenue", targetBranch: "develop" }));
    const target = loadConfig(targetConfig);
    assert.equal(target.owner, "acme");
    assert.equal(target.repo, "revenue");
    assert.equal(target.baseBranch, "develop");
    assert.equal(target.targetRepository, "acme/revenue");
    assert.equal(target.targetBacklogPath, "backlog");

    const legacyConfig = join(directory, "legacy.json");
    await writeFile(legacyConfig, JSON.stringify({ owner: "acme", repo: "legacy", baseBranch: "main" }));
    assert.equal(loadConfig(legacyConfig).targetRepository, "acme/legacy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads separate agent models and reasoning defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-agent-config-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ targetRepository: "acme/revenue", developerModel: "terra", developerReasoning: "high", reviewerModel: "luna", reviewerReasoning: "low" }));
  const config = loadConfig(configPath);
  assert.equal(config.developerModel, "terra");
  assert.equal(config.developerReasoning, "high");
  assert.equal(config.reviewerModel, "luna");
  assert.equal(config.reviewerReasoning, "low");
  await writeFile(configPath, JSON.stringify({ targetRepository: "acme/revenue", reviewerModel: "mars" }));
  assert.throws(() => loadConfig(configPath), /reviewerModel must be luna, sol, or terra/);
});

test("rejects a target workspace inside the control repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-workspace-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ targetRepository: "acme/revenue", targetWorkspace: join(directory, "target") }));
    const config = loadConfig(configPath);
    await assert.rejects(() => ensureTargetRepository(config, directory), /outside the ai-factory control repository/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses explicit story and run identity without enabling auto-merge", () => {
  const options = parseArgs(["--config", "run.json", "--max-stories", "1", "--story-id", "US-007", "--story-contract", "story.json", "--run-id", "run-123"]);
  assert.equal(options.storyId, "US-007"); assert.equal(options.runId, "run-123"); assert.equal(options.autoMerge, undefined);
  assert.equal(options.storyContractPath, "story.json");
  assert.throws(() => parseArgs(["--story-id", "bad"]), /US-###/);
});
