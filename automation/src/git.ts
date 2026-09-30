import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { OrchestrationConfig } from "./types.js";
import { targetWorkspacePath } from "./config.js";
import { runProcess } from "./processes.js";

export interface GitOptions { env?: NodeJS.ProcessEnv; }

async function git(cwd: string, args: string[], timeoutMs = 120_000, options: GitOptions = {}): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs, env: options.env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

export async function gitSha(cwd: string): Promise<string> { return git(cwd, ["rev-parse", "HEAD"]); }
export async function gitRoot(cwd: string): Promise<string> { return resolve(await git(cwd, ["rev-parse", "--show-toplevel"])); }
export async function gitStatus(cwd: string): Promise<string> { return git(cwd, ["status", "--porcelain"]); }
export async function gitDiff(cwd: string, baseBranch: string): Promise<string> { return git(cwd, ["diff", `${baseBranch}...HEAD`]); }
export async function commitAndPush(cwd: string, branch: string, message: string, options: GitOptions = {}): Promise<{ sha: string; changed: boolean }> {
  const status = await git(cwd, ["status", "--porcelain"], 120_000, options);
  if (!status) return { sha: await gitSha(cwd), changed: false };
  await git(cwd, ["add", "-A"], 120_000, options);
  await git(cwd, ["commit", "-m", message], 120_000, options);
  await git(cwd, ["push", "--set-upstream", "origin", branch], 120_000, options);
  return { sha: await gitSha(cwd), changed: true };
}

export interface Worktree { path: string; branch: string; }

export async function createWorktree(repoRoot: string, baseRef: string, branch: string, options: GitOptions = {}): Promise<Worktree> {
  const path = await mkdtemp(join(tmpdir(), "ai-factory-"));
  try {
    // A resumed story may only exist on origin. Fetch the named branch without changing
    // the user's checkout, then prefer that exact branch over recreating from base.
    await runProcess("git", ["fetch", "origin", branch], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    const existing = await runProcess("git", ["worktree", "add", path, branch], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (existing.code === 0) return { path, branch };
    const remote = await runProcess("git", ["worktree", "add", "-b", branch, path, `origin/${branch}`], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (remote.code === 0) return { path, branch };
    // The user's normal checkout usually has baseRef checked out already. A detached
    // worktree avoids trying to check out the same branch twice.
    const result = await runProcess("git", ["worktree", "add", "--detach", path, baseRef], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
    const branchResult = await runProcess("git", ["switch", "-c", branch], { cwd: path, timeoutMs: 120_000 });
    if (branchResult.code !== 0) throw new Error(`git switch failed: ${branchResult.stderr.trim() || branchResult.stdout.trim()}`);
    return { path, branch };
  } catch (error) {
    await runProcess("git", ["worktree", "remove", "--force", path], { cwd: repoRoot, timeoutMs: 120_000 });
    throw error;
  }
}

export async function removeWorktree(repoRoot: string, worktree: Worktree, options: GitOptions = {}): Promise<void> {
  const result = await runProcess("git", ["worktree", "remove", "--force", worktree.path], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
  if (result.code !== 0) throw new Error(`git worktree cleanup failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

export function gitAuthEnv(token?: string): NodeJS.ProcessEnv | undefined {
  if (!token) return undefined;
  return { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}` };
}

export async function ensureTargetRepository(config: OrchestrationConfig, controlRoot: string, token?: string): Promise<{ path: string; env?: NodeJS.ProcessEnv }> {
  const path = targetWorkspacePath(config, controlRoot);
  const control = resolve(controlRoot);
  const relativePath = relative(control, path);
  if (!relativePath.startsWith("..") || relativePath === "") throw new Error("target workspace must be outside the ai-factory control repository");
  const env = gitAuthEnv(token);
  const remoteUrl = `https://github.com/${config.targetRepository}.git`;
  if (config.controlRepository) {
    const controlRemote = await git(control, ["remote", "get-url", "origin"], 120_000, { env });
    if (!matchesRepository(controlRemote, config.controlRepository)) throw new Error(`control repository origin does not match ${config.controlRepository}`);
  }
  let exists = true;
  try { await access(path); } catch { exists = false; }
  if (exists) {
    const root = resolve(await git(path, ["rev-parse", "--show-toplevel"], 120_000, { env }));
    if (root !== path) throw new Error(`target workspace is not the repository root: ${path}`);
    const remote = await git(path, ["remote", "get-url", "origin"], 120_000, { env });
    if (!matchesRepository(remote, config.targetRepository)) throw new Error(`target workspace origin does not match ${config.targetRepository}`);
  } else {
    await mkdir(join(path, ".."), { recursive: true });
    const result = await runProcess("git", ["clone", remoteUrl, path], { cwd: controlRoot, timeoutMs: 120_000, env });
    if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  await git(path, ["fetch", "origin", config.targetBranch], 120_000, { env });
  return { path, env };
}

function matchesRepository(remote: string, repository: string): boolean {
  const normalized = remote.trim().replace(/\.git$/, "").replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").toLowerCase();
  return normalized === repository.toLowerCase();
}
