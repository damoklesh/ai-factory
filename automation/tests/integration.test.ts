import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPush, createWorktree, gitDiff, gitSha, gitStatus, inspectChanges, removeWorktree } from "../src/git.js";
import { runProcess } from "../src/processes.js";
import { runOrchestrator } from "../src/orchestrator.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("creates an isolated worktree, commits, pushes, and cleans it up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-git-integration-"));
  const repository = join(directory, "repo");
  const remote = join(directory, "remote.git");
  await mkdir(repository);
  await mkdir(remote);
  try {
    await git(remote, ["init", "--bare"]);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await git(repository, ["config", "user.name", "AI Factory Test"]);
    await writeFile(join(repository, "README.md"), "base\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "base"]);
    await git(repository, ["remote", "add", "origin", remote]);
    await git(repository, ["push", "--set-upstream", "origin", "main"]);
    const worktree = await createWorktree(repository, "main", "agent/issue-99");
    try {
      assert.equal(await gitStatus(worktree.path), "");
      await writeFile(join(worktree.path, "story.txt"), "implemented\n");
      const result = await commitAndPush(worktree.path, worktree.branch, "feat: test story");
      assert.equal(result.changed, true);
      assert.equal((await gitSha(worktree.path)), result.sha);
      assert.match(await gitDiff(worktree.path, "main"), /story.txt/);
      assert.match(await git(remote, ["for-each-ref", "--format=%\(refname\)", "refs/heads/agent/issue-99"]), /agent\/issue-99/);
    } finally {
      await removeWorktree(repository, worktree);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses a branch worktree left by an interrupted invocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-resume-"));
  const repository = join(directory, "repo");
  const remote = join(directory, "remote.git");
  try {
    await git(directory, ["init", "--bare", remote]);
    await git(directory, ["init", repository]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await git(repository, ["config", "user.name", "AI Factory Test"]);
    await writeFile(join(repository, "README.md"), "base\n");
    await git(repository, ["add", "README.md"]); await git(repository, ["commit", "-m", "base"]);
    await git(repository, ["branch", "-M", "main"]); await git(repository, ["remote", "add", "origin", remote]); await git(repository, ["push", "-u", "origin", "main"]);
    const first = await createWorktree(repository, "main", "agent/issue-101");
    await writeFile(join(first.path, "in-progress.txt"), "keep me\n");
    const resumed = await createWorktree(repository, "main", "agent/issue-101");
    assert.equal(resumed.path, first.path);
    assert.equal(resumed.reused, true);
    assert.equal(await readFile(join(resumed.path, "in-progress.txt"), "utf8"), "keep me\n");
    await removeWorktree(repository, resumed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs the mock sprint and configured dry-run through the CLI entrypoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-cli-integration-"));
  const config = join(directory, "config.json");
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    const mockCode = await runOrchestrator(["--mock", "--max-stories", "2"]);
    assert.equal(mockCode, 0);
    await writeFile(config, JSON.stringify({ owner: "owner", repo: "repo" }));
    const dryCode = await runOrchestrator(["--dry-run", "--config", config]);
    assert.equal(dryCode, 0);
    assert.ok(output.some((line) => line.includes("MOCK MERGED #1")));
    assert.ok(output.some((line) => line.includes("Target repository: owner/repo")));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspects the diff and refuses protected or secret-like files before staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-diff-policy-"));
  try {
    await git(directory, ["init"]); await git(directory, ["config", "user.email", "test@example.invalid"]); await git(directory, ["config", "user.name", "AI Factory Test"]); await writeFile(join(directory, "README.md"), "base\n"); await git(directory, ["add", "README.md"]); await git(directory, ["commit", "-m", "base"]);
    await writeFile(join(directory, "feature.txt"), "allowed\n"); assert.deepEqual(await inspectChanges(directory), ["feature.txt"]);
    await writeFile(join(directory, "TOKENS.txt"), "fixture-only\n"); await assert.rejects(() => inspectChanges(directory), /refusing to stage.*TOKENS\.txt/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refuses files outside configured story scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-scope-policy-"));
  try {
    await git(directory, ["init"]); await git(directory, ["config", "user.email", "test@example.invalid"]); await git(directory, ["config", "user.name", "AI Factory Test"]); await writeFile(join(directory, "README.md"), "base\n"); await git(directory, ["add", "README.md"]); await git(directory, ["commit", "-m", "base"]);
    await writeFile(join(directory, "src.txt"), "allowed\n");
    await assert.rejects(() => inspectChanges(directory, { allowedPaths: ["docs"] }), /out-of-scope.*src\.txt/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
