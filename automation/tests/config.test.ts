import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ensureTargetRepository } from "../src/git.js";

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
