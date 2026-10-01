import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { RecentProject, TargetProject } from "@ai-factory/contracts";

const execFileAsync = promisify(execFile);

interface ProjectIndex { activeProjectId?: string; projects: RecentProject[]; }

export class ProjectWorkspaceStore {
  readonly controlRoot: string;
  readonly dataRoot: string;

  constructor(controlRoot: string, dataRoot = join(controlRoot, ".agent", "projects"), private readonly backlogName = "backlog") {
    this.controlRoot = normalize(resolve(controlRoot));
    this.dataRoot = normalize(resolve(dataRoot));
  }

  async inspect(inputPath: string): Promise<TargetProject> {
    if (!inputPath.trim()) throw new Error("TARGET_PATH_REQUIRED: enter a local directory path");
    const requested = isAbsolute(inputPath) ? normalize(inputPath) : normalize(resolve(inputPath));
    let canonical: string;
    try { canonical = normalize(await realpath(requested)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`TARGET_NOT_FOUND: ${requested}`); throw error; }
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error(`TARGET_NOT_DIRECTORY: ${canonical}`);
    let writable = true;
    try { await access(canonical, constants.W_OK); } catch { writable = false; }

    const gitRootResult = await git(canonical, ["rev-parse", "--show-toplevel"]);
    const gitRoot = gitRootResult.ok ? normalize(await realpath(gitRootResult.stdout.trim())) : undefined;
    const projectRoot = gitRoot || canonical;
    const canonicalControlRoot = normalize(await realpath(this.controlRoot).catch(() => this.controlRoot));
    if (samePath(projectRoot, canonicalControlRoot)) throw new Error(`CONTROL_REPOSITORY_REJECTED: ${projectRoot}`);
    const currentBranch = gitRoot ? (await git(gitRoot, ["branch", "--show-current"])).stdout.trim() || undefined : undefined;
    const remotes = gitRoot ? await readRemotes(gitRoot) : [];
    const dirty = gitRoot ? Boolean((await git(gitRoot, ["status", "--porcelain", "--untracked-files=normal"])).stdout.trim()) : false;
    const backlogPath = join(projectRoot, this.backlogName);
    const backlogExists = await isDirectory(backlogPath);
    const github = githubRepository(remotes);
    return {
      projectId: projectId(projectRoot),
      requestedPath: requested,
      targetPath: projectRoot,
      gitRoot,
      isGitRepository: Boolean(gitRoot),
      currentBranch,
      baseBranch: currentBranch,
      remotes,
      dirty,
      writable,
      backlogPath,
      backlogExists,
      github,
      selectedAt: new Date().toISOString(),
    };
  }

  async select(inputPath: string): Promise<TargetProject> {
    const project = await this.inspect(inputPath);
    await this.persist(project);
    return project;
  }

  async initialize(inputPath: string, confirmationPath: string): Promise<TargetProject> {
    const inspected = await this.inspect(inputPath);
    if (inspected.isGitRepository) throw new Error(`GIT_ALREADY_INITIALIZED: ${inspected.gitRoot}`);
    const confirmed = normalize(isAbsolute(confirmationPath) ? confirmationPath : resolve(confirmationPath));
    if (!samePath(inspected.targetPath, confirmed)) throw new Error(`GIT_INIT_CONFIRMATION_MISMATCH: confirm the exact path ${inspected.targetPath}`);
    if (!inspected.writable) throw new Error(`TARGET_NOT_WRITABLE: ${inspected.targetPath}`);
    const result = await git(inspected.targetPath, ["init"]);
    if (!result.ok) throw new Error(`GIT_INIT_FAILED: ${result.stderr.trim() || "git init failed"}`);
    return this.select(inspected.targetPath);
  }

  async active(): Promise<TargetProject | undefined> {
    const index = await this.readIndex();
    if (!index.activeProjectId) return undefined;
    const recent = index.projects.find((item) => item.projectId === index.activeProjectId);
    if (!recent) return undefined;
    try { return await this.inspect(recent.targetPath); } catch { return undefined; }
  }

  async recent(): Promise<RecentProject[]> { return (await this.readIndex()).projects; }
  projectDataRoot(id: string): string { return join(this.dataRoot, id); }

  private async persist(project: TargetProject): Promise<void> {
    const index = await this.readIndex();
    const recent: RecentProject = { projectId: project.projectId, targetPath: project.targetPath, gitRoot: project.gitRoot, lastOpenedAt: project.selectedAt };
    const next: ProjectIndex = { activeProjectId: project.projectId, projects: [recent, ...index.projects.filter((item) => item.projectId !== project.projectId)].slice(0, 20) };
    await atomicJson(join(this.dataRoot, project.projectId, "project.json"), project);
    await atomicJson(join(this.dataRoot, "index.json"), next);
  }

  private async readIndex(): Promise<ProjectIndex> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dataRoot, "index.json"), "utf8")) as Partial<ProjectIndex>;
      return { activeProjectId: parsed.activeProjectId, projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [] }; throw error; }
  }
}

export function projectId(canonicalPath: string): string {
  const key = process.platform === "win32" ? normalize(canonicalPath).toLowerCase() : normalize(canonicalPath);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function readRemotes(root: string): Promise<Array<{ name: string; url: string }>> {
  const names = (await git(root, ["remote"])).stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort();
  const remotes: Array<{ name: string; url: string }> = [];
  for (const name of names) { const result = await git(root, ["remote", "get-url", name]); if (result.ok && result.stdout.trim()) remotes.push({ name, url: result.stdout.trim() }); }
  return remotes;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try { const result = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000 }); return { ok: true, stdout: result.stdout, stderr: result.stderr }; }
  catch (error) { const failure = error as Error & { stdout?: string; stderr?: string }; return { ok: false, stdout: failure.stdout || "", stderr: failure.stderr || failure.message }; }
}

async function isDirectory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
function samePath(left: string, right: string): boolean { const a = normalize(resolve(left)); const b = normalize(resolve(right)); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function githubRepository(remotes: Array<{ name: string; url: string }>): { owner: string; repo: string } | undefined { const remote = remotes.find((item) => item.name === "origin") || remotes[0]; const match = remote?.url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i); return match ? { owner: match[1], repo: match[2] } : undefined; }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, path); }
