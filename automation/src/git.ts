import { access, mkdir, mkdtemp, realpath } from "node:fs/promises";
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
export async function gitStatus(cwd: string, options: GitOptions = {}): Promise<string> { return git(cwd, ["status", "--porcelain"], 120_000, options); }
export async function gitDiff(cwd: string, baseBranch: string): Promise<string> { return git(cwd, ["diff", `${baseBranch}...HEAD`]); }
export async function inspectChanges(cwd: string, options: GitOptions & { allowedPaths?: string[] } = {}): Promise<string[]> {
  const sources = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z"], 120_000, options),
    git(cwd, ["diff", "--cached", "--name-only", "-z"], 120_000, options),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], 120_000, options),
  ]);
  const files = [...new Set(sources.flatMap((value) => value.split("\0").map((item) => item.trim()).filter(Boolean)))].sort();
  const denied = files.filter(deniedChange);
  if (denied.length) throw new Error(`refusing to stage protected or secret-like paths: ${denied.join(", ")}`);
  const allowed = (options.allowedPaths || []).map(normalizePrefix).filter(Boolean);
  if (allowed.length) {
    const outOfScope = files.filter((file) => !allowed.some((prefix) => file.replaceAll("\\", "/").toLowerCase() === prefix || file.replaceAll("\\", "/").toLowerCase().startsWith(`${prefix}/`)));
    if (outOfScope.length) throw new Error(`refusing to stage out-of-scope paths: ${outOfScope.join(", ")}`);
  }
  const check = await runProcess("git", ["diff", "--check"], { cwd, timeoutMs: 120_000, env: options.env });
  if (check.code !== 0) throw new Error(`refusing to stage a malformed diff: ${check.stdout.trim() || check.stderr.trim()}`);
  return files;
}
export async function commitAndPush(cwd: string, branch: string, message: string, options: GitOptions & { allowedPaths?: string[] } = {}): Promise<{ sha: string; changed: boolean; files: string[] }> {
  const commit = await commitLocal(cwd, message, options);
  if (commit.changed) await pushBranch(cwd, branch, options);
  return commit;
}

/** Create a visible local checkpoint without publishing it to GitHub. */
export async function commitLocal(cwd: string, message: string, options: GitOptions & { allowedPaths?: string[] } = {}): Promise<{ sha: string; changed: boolean; files: string[] }> {
  const status = await git(cwd, ["status", "--porcelain"], 120_000, options);
  if (!status) return { sha: await gitSha(cwd), changed: false, files: [] };
  const files = await inspectChanges(cwd, options);
  if (!files.length) return { sha: await gitSha(cwd), changed: false, files: [] };
  await git(cwd, ["add", "--", ...files], 120_000, options);
  await git(cwd, ["commit", "-m", message], 120_000, options);
  return { sha: await gitSha(cwd), changed: true, files };
}

export async function pushBranch(cwd: string, branch: string, options: GitOptions = {}): Promise<void> {
  await git(cwd, ["push", "--set-upstream", "origin", branch], 120_000, options);
}

/** Collapse local implementation/fixing checkpoints into one pre-PR commit. */
export async function squashBranch(cwd: string, baseRef: string, message: string, options: GitOptions & { allowedPaths?: string[] } = {}): Promise<{ sha: string; changed: boolean; files: string[] }> {
  const base = await git(cwd, ["rev-parse", baseRef], 120_000, options).catch(() => git(cwd, ["rev-parse", `origin/${baseRef}`], 120_000, options));
  await git(cwd, ["reset", "--soft", base], 120_000, options);
  return commitLocal(cwd, message, options);
}

export interface Worktree { path: string; branch: string; reused?: boolean; }

async function findExistingWorktree(repoRoot: string, branch: string, options: GitOptions = {}): Promise<Worktree | undefined> {
  const result = await runProcess("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
  if (result.code !== 0) return undefined;
  const blocks = result.stdout.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/));
  const ref = `branch refs/heads/${branch}`;
  for (const lines of blocks) {
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim();
    if (path && lines.some((line) => line.trim() === ref)) {
      try { await access(path); } catch { await runProcess("git", ["worktree", "prune"], { cwd: repoRoot, timeoutMs: 120_000, env: options.env }); continue; }
      return { path: await realpath(path).catch(() => resolve(path)), branch, reused: true };
    }
  }
  return undefined;
}

export async function createWorktree(repoRoot: string, baseRef: string, branch: string, options: GitOptions = {}): Promise<Worktree> {
  const existing = await findExistingWorktree(repoRoot, branch, options);
  if (existing) return existing;
  const path = await mkdtemp(join(tmpdir(), "ai-factory-"));
  try {
    // A resumed story may only exist on origin. Fetch the named branch without changing
    // the user's checkout, then prefer that exact branch over recreating from base.
    await runProcess("git", ["fetch", "origin", branch], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    // When a previous invocation published a commit, the local branch can be
    // behind origin even though no worktree is currently registered. Fast
    // forward only; never discard local commits or dirty work.
    const ancestor = await runProcess("git", ["merge-base", "--is-ancestor", branch, `origin/${branch}`], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (ancestor.code === 0) await runProcess("git", ["branch", "--force", branch, `origin/${branch}`], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    const existing = await runProcess("git", ["worktree", "add", path, branch], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (existing.code === 0) return { path: await realpath(path), branch };
    const remote = await runProcess("git", ["worktree", "add", "-b", branch, path, `origin/${branch}`], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (remote.code === 0) return { path: await realpath(path), branch };
    // The user's normal checkout usually has baseRef checked out already. A detached
    // worktree avoids trying to check out the same branch twice.
    const result = await runProcess("git", ["worktree", "add", "--detach", path, baseRef], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    const remoteBase = result.code === 0 ? result : await runProcess("git", ["worktree", "add", "--detach", path, `origin/${baseRef}`], { cwd: repoRoot, timeoutMs: 120_000, env: options.env });
    if (remoteBase.code !== 0) throw new Error(`git worktree add failed: ${remoteBase.stderr.trim() || remoteBase.stdout.trim()}`);
    const branchResult = await runProcess("git", ["switch", "-c", branch], { cwd: path, timeoutMs: 120_000 });
    if (branchResult.code !== 0) throw new Error(`git switch failed: ${branchResult.stderr.trim() || branchResult.stdout.trim()}`);
    return { path: await realpath(path), branch };
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
  const basicCredentials = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicCredentials}` };
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
    if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr.trim() || result.stdout.trim()} Check that AGENT_GH_TOKEN is valid and has access to ${config.targetRepository}.`);
  }
  await git(path, ["fetch", "origin", config.targetBranch], 120_000, { env });
  return { path, env };
}

function matchesRepository(remote: string, repository: string): boolean {
  const normalized = remote.trim().replace(/\.git$/, "").replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").toLowerCase();
  return normalized === repository.toLowerCase();
}

function deniedChange(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase(); const name = normalized.split("/").at(-1) || normalized;
  return normalized === "agents.md" || normalized.startsWith(".agent/") || normalized.startsWith(".github/workflows/") || normalized === "automation/config.json" || /^\.env(?:\.|$)/.test(name) || /(token|credential|secret|auth)(?:s)?\.(?:txt|json|ya?ml)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function normalizePrefix(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").trim().toLowerCase();
}
