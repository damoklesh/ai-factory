import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./processes.js";

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

export async function gitSha(cwd: string): Promise<string> { return git(cwd, ["rev-parse", "HEAD"]); }
export async function gitStatus(cwd: string): Promise<string> { return git(cwd, ["status", "--porcelain"]); }
export async function gitDiff(cwd: string, baseBranch: string): Promise<string> { return git(cwd, ["diff", `${baseBranch}...HEAD`]); }
export async function commitAndPush(cwd: string, branch: string, message: string): Promise<{ sha: string; changed: boolean }> {
  const status = await gitStatus(cwd);
  if (!status) return { sha: await gitSha(cwd), changed: false };
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
  await git(cwd, ["push", "--set-upstream", "origin", branch]);
  return { sha: await gitSha(cwd), changed: true };
}

export interface Worktree { path: string; branch: string; }

export async function createWorktree(repoRoot: string, baseRef: string, branch: string): Promise<Worktree> {
  const path = await mkdtemp(join(tmpdir(), "ai-factory-"));
  try {
    // A resumed story may only exist on origin. Fetch the named branch without changing
    // the user's checkout, then prefer that exact branch over recreating from base.
    await runProcess("git", ["fetch", "origin", branch], { cwd: repoRoot, timeoutMs: 120_000 });
    const existing = await runProcess("git", ["worktree", "add", path, branch], { cwd: repoRoot, timeoutMs: 120_000 });
    if (existing.code === 0) return { path, branch };
    const remote = await runProcess("git", ["worktree", "add", "-b", branch, path, `origin/${branch}`], { cwd: repoRoot, timeoutMs: 120_000 });
    if (remote.code === 0) return { path, branch };
    const result = await runProcess("git", ["worktree", "add", path, baseRef], { cwd: repoRoot, timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
    const branchResult = await runProcess("git", ["switch", "-c", branch], { cwd: path, timeoutMs: 120_000 });
    if (branchResult.code !== 0) throw new Error(`git switch failed: ${branchResult.stderr.trim() || branchResult.stdout.trim()}`);
    return { path, branch };
  } catch (error) {
    await runProcess("git", ["worktree", "remove", "--force", path], { cwd: repoRoot, timeoutMs: 120_000 });
    throw error;
  }
}

export async function removeWorktree(repoRoot: string, worktree: Worktree): Promise<void> {
  const result = await runProcess("git", ["worktree", "remove", "--force", worktree.path], { cwd: repoRoot, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`git worktree cleanup failed: ${result.stderr.trim() || result.stdout.trim()}`);
}
