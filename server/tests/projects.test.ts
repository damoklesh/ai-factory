import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";
import { projectId, ProjectWorkspaceStore } from "../src/projects.js";

const execFileAsync = promisify(execFile);
const canonicalStory = `---
storyId: US-001
title: Inspect target project
priority: 1
dependencies: none
---
# US-001 — Inspect target project

## User Story
As a user, I want the selected target inspected so that work is safe.

## Scope
- In scope: target inspection

## Acceptance Criteria
- [ ] AC-1: The target root is explicit.

## Validation
- [ ] Run tests.
`;

async function gitInit(path: string): Promise<void> { await execFileAsync("git", ["init", path], { windowsHide: true }); }

test("validates paths, resolves a nested Git root, and reports dirty state without mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ai-factory-project-"));
  const control = join(sandbox, "control"); const target = join(sandbox, "target"); const nested = join(target, "src", "nested");
  await mkdir(control); await mkdir(nested, { recursive: true }); await gitInit(target);
  await writeFile(join(target, "local.txt"), "uncommitted", "utf8");
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects"));
  const inspected = await store.inspect(nested);
  const canonicalTarget = normalize(await realpath(target));
  assert.equal(normalize(inspected.gitRoot!), canonicalTarget);
  assert.equal(normalize(inspected.targetPath), canonicalTarget);
  assert.equal(inspected.dirty, true);
  assert.equal(inspected.remotes.length, 0);
  assert.equal(inspected.backlogPath, join(canonicalTarget, "backlog"));
  assert.equal(inspected.projectId, projectId(canonicalTarget));
  await assert.rejects(() => store.inspect(join(sandbox, "missing")), /TARGET_NOT_FOUND/);
  const file = join(sandbox, "file.txt"); await writeFile(file, "file", "utf8");
  await assert.rejects(() => store.inspect(file), /TARGET_NOT_DIRECTORY/);
});

test("requires exact confirmation before git init and rejects the control repository", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ai-factory-project-init-"));
  const control = join(sandbox, "control"); const target = join(sandbox, "plain");
  await mkdir(control); await mkdir(target); await gitInit(control);
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects"));
  await assert.rejects(() => store.inspect(control), /CONTROL_REPOSITORY_REJECTED/);
  const before = await store.inspect(target); assert.equal(before.isGitRepository, false);
  await assert.rejects(() => store.initialize(target, `${target}-wrong`), /GIT_INIT_CONFIRMATION_MISMATCH/);
  await assert.rejects(() => stat(join(target, ".git")), /ENOENT/);
  const initialized = await store.initialize(target, before.targetPath);
  assert.equal(initialized.isGitRepository, true);
  assert.equal((await store.recent())[0].projectId, initialized.projectId);
  assert.equal((await store.active())?.projectId, initialized.projectId);
});

test("switches controller backlog and state to the selected project", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ai-factory-project-controller-"));
  const control = join(sandbox, "control"); const target = join(sandbox, "target"); const backlog = join(target, "backlog");
  await mkdir(control); await mkdir(backlog, { recursive: true }); await gitInit(target);
  await writeFile(join(backlog, "US-001-inspect.md"), canonicalStory, "utf8");
  const dataRoot = join(control, ".agent", "projects"); const store = new ProjectWorkspaceStore(control, dataRoot);
  const controller = new LocalController(new AgentPersistence(join(dataRoot, "unselected")), { projectStore: store });
  assert.equal((await controller.project()).target, undefined);
  const selected = await controller.selectProject(join(target, "backlog"));
  assert.equal(selected.targetPath, normalize(await realpath(target)));
  assert.deepEqual((await controller.listStories()).map((item) => item.storyId), ["US-001"]);
  const run = await controller.start({ maxStories: 1, autoMerge: false });
  assert.equal(run.storyId, "US-001");
  const snapshot = JSON.parse(await readFile(join(dataRoot, selected.projectId, "runs", run.runId, "snapshot.json"), "utf8")) as { runId: string };
  assert.equal(snapshot.runId, run.runId);
  await assert.rejects(() => stat(join(target, ".agent")), /ENOENT/);
});
