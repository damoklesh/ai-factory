import { spawn } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfigView, StoryDetail, TargetProject } from "@ai-factory/contracts";
import { sanitizeText } from "./persistence.js";

export interface ExecutionContext {
  runId: string;
  story: StoryDetail;
  project: TargetProject;
  controlRoot: string;
  stateRoot: string;
  configRevision: string;
  config: AppConfigView;
}
export interface ExecutionOutcome { status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED"; summary: string; exitCode?: number | null; }
export interface ExecutionHandle { pid?: number; completion: Promise<ExecutionOutcome>; cancel?: () => Promise<void>; }
export interface ExecutionService { start(context: ExecutionContext): Promise<ExecutionHandle>; }

export class ChildProcessExecutionService implements ExecutionService {
  private readonly activeProjects = new Map<string, string>();
  constructor(private readonly onOutput?: (runId: string, stream: "stdout" | "stderr", chunk: string) => void) {}

  async start(context: ExecutionContext): Promise<ExecutionHandle> {
    if (this.activeProjects.has(context.project.projectId)) throw new Error("RUN_ALREADY_ACTIVE_FOR_PROJECT");
    if (!context.project.isGitRepository || !context.project.gitRoot) throw new Error("TARGET_GIT_REQUIRED");
    if (!context.project.github) throw new Error("TARGET_GITHUB_REMOTE_REQUIRED");
    if (!context.story.githubIssueNumber) throw new Error("STORY_NOT_SYNCED_TO_GITHUB");
    const script = join(context.controlRoot, "automation", "dist", "src", "orchestrator.js"); await access(script);
    await mkdir(context.stateRoot, { recursive: true });
    const configPath = join(context.stateRoot, `run-${context.runId}.config.json`);
    const storyContractPath = join(context.stateRoot, `run-${context.runId}.story.json`);
    const config = {
      targetRepository: `${context.project.github.owner}/${context.project.github.repo}`,
      targetBranch: context.project.baseBranch || context.project.currentBranch || "main",
      targetBacklogPath: "backlog",
      targetWorkspace: context.project.targetPath,
      validationCommands: context.config.validationCommands,
      requiredChecks: context.config.requiredChecks,
      maxStories: 1,
      maxFixCycles: context.config.maxFixCycles,
      autoMerge: false,
      stateFile: join(context.stateRoot, "orchestrator-state.json"),
      logDirectory: join(context.stateRoot, "logs"),
      runId: context.runId,
      selectedStoryId: context.story.storyId,
      configRevision: context.configRevision,
    };
    const temp = `${configPath}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8"); await rename(temp, configPath);
    const storyContract = { objective: context.story.objective, acceptanceCriteria: context.story.acceptanceCriteria, scope: context.story.scope, dependencies: [], priority: context.story.priority, validation: context.story.validation };
    const storyTemp = `${storyContractPath}.${process.pid}.tmp`; await writeFile(storyTemp, `${JSON.stringify(storyContract, null, 2)}\n`, "utf8"); await rename(storyTemp, storyContractPath);
    const args = [script, "--config", configPath, "--max-stories", "1", "--story-id", context.story.storyId, "--story-contract", storyContractPath, "--run-id", context.runId];
    const child = spawn(process.execPath, args, { cwd: context.controlRoot, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.activeProjects.set(context.project.projectId, context.runId);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value: Buffer) => { const chunk = sanitizeText(value.toString()); stdout = bounded(stdout, chunk); this.onOutput?.(context.runId, "stdout", chunk); });
    child.stderr.on("data", (value: Buffer) => { const chunk = sanitizeText(value.toString()); stderr = bounded(stderr, chunk); this.onOutput?.(context.runId, "stderr", chunk); });
    const completion = new Promise<ExecutionOutcome>((resolve) => child.on("close", (code, signal) => { this.activeProjects.delete(context.project.projectId); if (signal) resolve({ status: "CANCELLED", summary: `Orchestrator stopped by ${signal}`, exitCode: code }); else if (code === 0) resolve({ status: "SUCCEEDED", summary: lastMessage(stdout) || "Orchestrator completed successfully.", exitCode: code }); else resolve({ status: "FAILED", summary: lastMessage(stderr) || lastMessage(stdout) || `Orchestrator exited with ${code}`, exitCode: code }); }));
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error) => { this.activeProjects.delete(context.project.projectId); reject(error); }); });
    return { pid: child.pid, completion, cancel: async () => { if (!child.killed) child.kill("SIGTERM"); } };
  }
}

function bounded(current: string, chunk: string): string { const value = `${current}${chunk}`; return value.length > 1_000_000 ? value.slice(-1_000_000) : value; }
function lastMessage(value: string): string { return value.trim().split(/\r?\n/).filter(Boolean).at(-1) || ""; }
