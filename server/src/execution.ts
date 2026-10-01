import { execFile, spawn } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfigView, RunPhase, StoryDetail, TargetProject } from "@ai-factory/contracts";
import { sanitizeText } from "./persistence.js";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export interface ExecutionContext {
  runId: string;
  story: StoryDetail;
  project: TargetProject;
  controlRoot: string;
  stateRoot: string;
  configRevision: string;
  config: AppConfigView;
  instructions?: string[];
  resume?: boolean;
  freshStart?: boolean;
  onEvent?: (event: ExecutionProcessEvent) => void;
}
export interface ExecutionProcessEvent {
  source: "orchestrator" | "developer" | "reviewer" | "git" | "github" | "validation";
  phase: RunPhase;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  command?: string;
  activity?: "RUNNING" | "WAITING_FOR_INPUT" | "WAITING_FOR_CHECKS";
  outcome?: string;
}
export interface ExecutionOutcome { status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED"; summary: string; exitCode?: number | null; }
export interface ExecutionHandle { pid?: number; completion: Promise<ExecutionOutcome>; cancel?: () => Promise<void>; }
export interface ExecutionService { start(context: ExecutionContext): Promise<ExecutionHandle>; }

export class ChildProcessExecutionService implements ExecutionService {
  private readonly activeProjects = new Map<string, string>();
  constructor(private readonly onOutput?: (runId: string, stream: "stdout" | "stderr", chunk: string) => void, private readonly timeoutMs = 0) {}

  async start(context: ExecutionContext): Promise<ExecutionHandle> {
    if (this.activeProjects.has(context.project.projectId)) throw new Error("RUN_ALREADY_ACTIVE_FOR_PROJECT");
    if (!context.project.isGitRepository || !context.project.gitRoot) throw new Error("TARGET_GIT_REQUIRED");
    if (!context.project.github) throw new Error("TARGET_GITHUB_REMOTE_REQUIRED");
    if (!context.story.githubIssueNumber) throw new Error("STORY_NOT_SYNCED_TO_GITHUB");
    const script = join(context.controlRoot, "automation", "dist", "src", "orchestrator.js"); await access(script);
    await mkdir(context.stateRoot, { recursive: true });
    const configPath = join(context.stateRoot, `run-${context.runId}.config.json`);
    const storyContractPath = join(context.stateRoot, `run-${context.runId}.story.json`);
    const instructionPath = join(context.stateRoot, `run-${context.runId}.instructions.json`);
    const config = {
      targetRepository: `${context.project.github.owner}/${context.project.github.repo}`,
      targetBranch: context.project.baseBranch || context.project.currentBranch || "main",
      targetBacklogPath: "backlog",
      targetWorkspace: context.project.targetPath,
      modelVersion: context.config.modelVersion,
      developerModel: context.config.developerModel,
      developerReasoning: context.config.developerReasoning,
      reviewerModel: context.config.reviewerModel,
      reviewerReasoning: context.config.reviewerReasoning,
      developerPrompt: context.config.developerPrompt,
      reviewerPrompt: context.config.reviewerPrompt,
      validationCommands: context.config.validationCommands,
      requiredChecks: context.config.requiredChecks,
      maxStories: 1,
      maxFixCycles: context.config.maxFixCycles,
      maxValidationAttempts: context.config.maxValidationAttempts,
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
    const instructionTemp = `${instructionPath}.${process.pid}.tmp`; await writeFile(instructionTemp, `${JSON.stringify(context.instructions || [], null, 2)}\n`, "utf8"); await rename(instructionTemp, instructionPath);
    const args = [script, "--config", configPath, "--max-stories", "1", "--story-id", context.story.storyId, "--story-contract", storyContractPath, "--instruction-file", instructionPath, "--run-id", context.runId];
    if (context.resume) args.push("--resume");
    if (context.freshStart) args.push("--fresh-start");
    const child = spawn(process.execPath, args, { cwd: context.controlRoot, env: process.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    this.activeProjects.set(context.project.projectId, context.runId);
    let stdout = ""; let stderr = ""; let stdoutBuffer = ""; let stderrBuffer = ""; let terminalOutcome: string | undefined; let timedOut = false; let cancelRequested = false;
    const consume = (stream: "stdout" | "stderr", value: Buffer) => { const chunk = sanitizeText(value.toString()); if (stream === "stdout") stdout = bounded(stdout, chunk); else stderr = bounded(stderr, chunk); this.onOutput?.(context.runId, stream, chunk); const combined = `${stream === "stdout" ? stdoutBuffer : stderrBuffer}${chunk}`; const lines = combined.split(/\r?\n/); if (stream === "stdout") stdoutBuffer = lines.pop() || ""; else stderrBuffer = lines.pop() || ""; for (const line of lines) { const event = normalizeProcessLine(line, stream); if (event.outcome) terminalOutcome = event.outcome; context.onEvent?.(event); } };
    child.stdout.on("data", (value: Buffer) => consume("stdout", value)); child.stderr.on("data", (value: Buffer) => consume("stderr", value));
    const timeout = this.timeoutMs > 0 ? setTimeout(() => { timedOut = true; void terminateProcessTree(child.pid); }, this.timeoutMs) : undefined;
    const completion = new Promise<ExecutionOutcome>((resolve) => child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (stdoutBuffer) { const event = normalizeProcessLine(stdoutBuffer, "stdout"); if (event.outcome) terminalOutcome = event.outcome; context.onEvent?.(event); }
      if (stderrBuffer) context.onEvent?.(normalizeProcessLine(stderrBuffer, "stderr"));
      this.activeProjects.delete(context.project.projectId);
      if (timedOut) resolve({ status: "FAILED", summary: `Orchestrator timed out after ${this.timeoutMs}ms`, exitCode: code });
      else if (cancelRequested) resolve({ status: "CANCELLED", summary: "Orchestrator cancelled by user", exitCode: code });
      else if (signal) resolve({ status: "CANCELLED", summary: `Orchestrator stopped by ${signal}`, exitCode: code });
      else if (code !== 0) resolve({ status: "FAILED", summary: lastMessage(stdout) || meaningfulStderr(stderr) || terminalOutcome || `Orchestrator exited with ${code}`, exitCode: code });
      else if (/NEEDS_HUMAN|PAUSED_AUTH|PAUSED_QUOTA/i.test(terminalOutcome || "")) resolve({ status: "BLOCKED", summary: lastMessage(stdout) || terminalOutcome || meaningfulStderr(stderr) || "Orchestrator needs input.", exitCode: code });
      else if (/FAILED/i.test(terminalOutcome || "")) resolve({ status: "FAILED", summary: lastMessage(stdout) || terminalOutcome || meaningfulStderr(stderr) || "Orchestrator failed.", exitCode: code });
      else resolve({ status: "SUCCEEDED", summary: lastMessage(stdout) || meaningfulStderr(stderr) || "Orchestrator completed successfully.", exitCode: code });
    }));
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error) => { this.activeProjects.delete(context.project.projectId); reject(error); }); });
    return { pid: child.pid, completion, cancel: async () => { cancelRequested = true; await terminateProcessTree(child.pid); } };
  }
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") { await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined); return; }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
}

function bounded(current: string, chunk: string): string { const value = `${current}${chunk}`; return value.length > 1_000_000 ? value.slice(-1_000_000) : value; }
function lastMessage(value: string): string { return value.trim().split(/\r?\n/).filter(Boolean).at(-1) || ""; }
function meaningfulStderr(value: string): string { return value.trim().split(/\r?\n/).filter(Boolean).filter((line) => !/^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/.test(line) && !/^\(Use `node --trace-deprecation/.test(line)).at(-1) || ""; }
function normalizeProcessLine(line: string, stream: "stdout" | "stderr"): ExecutionProcessEvent {
  const safe = sanitizeText(line).slice(0, 32_000);
  try {
    const parsed = JSON.parse(safe) as Partial<ExecutionProcessEvent> & { aiFactoryEvent?: boolean };
    if (parsed.aiFactoryEvent && typeof parsed.message === "string") return {
      source: parsed.source || "orchestrator", phase: parsed.phase || "IMPLEMENTING", level: parsed.level || "INFO",
      message: sanitizeText(parsed.message).slice(0, 32_000), command: parsed.command ? sanitizeText(parsed.command).slice(0, 2_000) : undefined,
      activity: parsed.activity, outcome: parsed.outcome,
    };
  } catch { /* plain operational output */ }
  return { source: "orchestrator", phase: "IMPLEMENTING", level: stream === "stderr" ? "ERROR" : "INFO", message: safe || "(empty process output)", activity: "RUNNING" };
}
