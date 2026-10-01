export const SCHEMA_VERSION = 1;

export type DeliveryStatus = "NOT_STARTED" | "IMPLEMENTING" | "PR_OPEN" | "MERGED";
export type ExecutionStatus = "IDLE" | "ACTIVE" | "PAUSE_REQUESTED" | "PAUSED" | "STOP_REQUESTED" | "STOPPED" | "FINISHED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "BLOCKED";
export type ValidationStatus = "PENDING" | "PASS" | "FAIL" | "UNKNOWN" | "STALE";
export type RunPhase = "SELECTING" | "IMPLEMENTING" | "TESTING" | "CI" | "REVIEWING" | "FIXING" | "MERGING" | "WAITING" | "PAUSED" | "STOPPED" | "FINISHED";
export type WorkflowStage = "IMPLEMENTING" | "PR_OPEN" | "REVIEWING" | "REVIEW_CHANGES_REQUESTED" | "FIXING_REVIEW" | "REVALIDATING" | "WAITING_FOR_CI" | "READY_FOR_MERGE" | "MERGE_PENDING_APPROVAL" | "MERGED" | "NEEDS_HUMAN" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export type AgentProcessStatus = "STARTING" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "LOST" | "UNKNOWN";

export interface StoryDiagnostic {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  file: string;
  line: number;
}

export interface StorySummary {
  storyId: string;
  title: string;
  priority: number;
  dependencies: string[];
  deliveryStatus: DeliveryStatus;
  executionStatus: ExecutionStatus;
  validationStatus: ValidationStatus;
  specSource: "repository" | "github";
  specRevision: string;
  githubIssueNumber?: number;
  pullRequestNumber?: number;
  headSha?: string;
  blockedReason?: string;
  updatedAt: string;
  dependencyError?: string;
  issueUrl?: string;
  pullRequestUrl?: string;
  validatedHeadSha?: string;
  externalStatus?: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  externalStale?: boolean;
  agentStatus?: string;
  agentReason?: string;
  branch?: string;
  sourceFile?: string;
  valid?: boolean;
  diagnostics?: StoryDiagnostic[];
  labels?: string[];
  workflowStage?: WorkflowStage;
  stageStartedAt?: string;
  stageUpdatedAt?: string;
  nextAction?: string;
  agentProcess?: { role: "IMPLEMENTER" | "REVIEWER" | "FIXER"; status: AgentProcessStatus; pid?: number; startedAt?: string; lastEventAt?: string; exitCode?: number | null };
}

export interface StoryDetail extends StorySummary {
  objective: string;
  acceptanceCriteria: string[];
  scope: string;
  validation: string[];
  markdown: string;
  conflict?: { repositoryRevision: string; githubRevision: string; summary: string };
  dependencyError?: string;
  issueUrl?: string;
  pullRequestUrl?: string;
  syncStatus?: "IN_SYNC" | "CONFLICT" | "LOCAL_ONLY" | "GITHUB_ONLY";
  validatedHeadSha?: string;
  externalStatus?: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  externalStale?: boolean;
}

export interface GithubObservation { storyId: string; githubIssueNumber?: number; pullRequestNumber?: number; headSha?: string; validatedHeadSha?: string; state: "OPEN" | "CLOSED" | "MERGED"; checks: "PASS" | "FAIL" | "PENDING" | "UNKNOWN"; checkedAt: string; }
export interface SyncResult { connected: boolean; stale: boolean; syncedAt?: string; message: string; changedStoryIds: string[]; }
export interface BacklogValidation { valid: boolean; diagnostics: StoryDiagnostic[]; template: string; }
export type BacklogSyncActionKind = "CREATE" | "UPDATE" | "UNCHANGED" | "CONFLICT";
export interface BacklogSyncAction { storyId: string; kind: BacklogSyncActionKind; issueNumber?: number; localRevision: string; remoteRevision?: string; reason?: string; }
export interface BacklogSyncPreview { previewId: string; generatedAt: string; actions: BacklogSyncAction[]; }
export interface BacklogSyncRequest { previewId: string; resolutions: Array<{ storyId: string; decision: "USE_LOCAL" | "KEEP_REMOTE" }>; }
export interface BacklogSyncPublishResult { previewId: string; created: Array<{ storyId: string; issueNumber: number }>; updated: Array<{ storyId: string; issueNumber: number }>; unchanged: Array<{ storyId: string; issueNumber: number }>; conflicts: BacklogSyncAction[]; failures: Array<{ storyId: string; message: string }>; }

export interface ProjectSnapshot {
  schemaVersion: number;
  repository: { owner: string; repo: string; baseBranch: string };
  controller: { available: boolean; version: string; message?: string };
  github: { connected: boolean; checkedAt?: string; stale: boolean; message?: string };
  codex: { available: boolean; message?: string };
  activeRunId?: string;
  counts: { total: number; done: number; blocked: number; active: number };
  lastSyncAt?: string;
  diagnostics?: Diagnostic[];
  target?: TargetProject;
  recentProjects?: RecentProject[];
}

export interface ProjectRemote { name: string; url: string; }
export interface TargetProject {
  projectId: string;
  requestedPath: string;
  targetPath: string;
  gitRoot?: string;
  isGitRepository: boolean;
  currentBranch?: string;
  baseBranch?: string;
  remotes: ProjectRemote[];
  dirty: boolean;
  writable: boolean;
  backlogPath: string;
  backlogExists: boolean;
  github?: { owner: string; repo: string };
  selectedAt: string;
}
export interface RecentProject { projectId: string; targetPath: string; gitRoot?: string; lastOpenedAt: string; }
export interface SelectProjectRequest { targetPath: string; }
export interface InitProjectRequest { targetPath: string; confirmationPath: string; }
export type ProjectStack = "node" | "java" | "python" | "dotnet" | "go" | "mixed" | "unknown";
export interface ProjectDoctorReport { stack: ProjectStack; detectedStacks: Exclude<ProjectStack, "mixed" | "unknown">[]; confidence: "CONFIRMED" | "AMBIGUOUS" | "UNKNOWN"; evidence: Array<{ path: string; reason: string }>; validationCommands: string[]; documentation: Array<{ path: string; exists: boolean }>; inspectedAt: string; }
export interface ScaffoldPlan { stack: Exclude<ProjectStack, "mixed" | "unknown">; files: Array<{ path: string; action: "CREATE" | "KEEP"; purpose: string }>; validationCommands: string[]; requiresConfirmation: true; }
export interface ScaffoldResult { branch: string; worktreePath: string; filesCreated: string[]; filesKept: string[]; validation: Array<{ command: string; status: "SKIPPED" | "PASS" | "FAIL"; detail: string }>; }

export interface Diagnostic {
  name: string;
  available: boolean;
  message?: string;
}

export interface LogEntry {
  schemaVersion: number;
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  source: "controller" | "orchestrator" | "developer" | "reviewer" | "git" | "github" | "validation";
  phase: RunPhase;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  command?: string;
  durationMs?: number;
  exitCode?: number | null;
  redacted?: boolean;
}

export interface LogPage { entries: LogEntry[]; nextCursor?: number; hasMore: boolean; truncated?: boolean; }

export interface RunSnapshot {
  schemaVersion: number;
  runId: string;
  storyId?: string;
  status: ExecutionStatus;
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
  attempts: number;
  maxStories: number;
  autoMerge: boolean;
  currentHeadSha?: string;
  validatedHeadSha?: string;
  validationStatus: ValidationStatus;
  pauseRequested?: boolean;
  stopRequested?: boolean;
  interruptionReason?: string;
  effectiveConfigRevision: string;
  effectiveSpecRevision?: string;
  selectionMode?: "selected" | "auto";
  targetProjectId?: string;
  processId?: number;
  resultSummary?: string;
  activity?: "IDLE" | "RUNNING" | "WAITING_FOR_INPUT" | "WAITING_FOR_CHECKS";
  selectionPlan?: string[];
  completedStories?: string[];
  remainingStories?: string[];
  stopReason?: string;
  recoveryStatus?: "VERIFIED_RUNNING" | "WAITING" | "INTERRUPTED" | "UNKNOWN";
}

export interface ApprovalRequest {
  schemaVersion: number;
  requestId: string;
  runId: string;
  storyId: string;
  type: "CLARIFICATION" | "SCOPE_CHANGE" | "CONTINUE_FIXES" | "EXCEPTION" | "MERGE";
  status: "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED";
  problem: string;
  evidence: string[];
  proposedAction: string;
  expectedHeadSha?: string;
  expectedSpecRevision?: string;
  createdAt: string;
  decidedAt?: string;
  reason?: string;
}

export interface AppConfigView {
  owner: string;
  repo: string;
  baseBranch: string;
  controlRepository?: string;
  targetRepository?: string;
  targetBranch?: string;
  targetBacklogPath?: string;
  targetWorkspace?: string;
  model?: string;
  /** Base model family/version used to resolve role-specific Codex model IDs. */
  modelVersion: string;
  developerModel: "luna" | "sol" | "terra";
  developerReasoning: "low" | "medium" | "high" | "xhigh";
  reviewerModel: "luna" | "sol" | "terra";
  reviewerReasoning: "low" | "medium" | "high" | "xhigh";
  validationCommands: string[];
  requiredChecks: string[];
  maxStories: number;
  maxFixCycles: number;
  maxValidationAttempts: number;
  autoMerge: boolean;
  stateFile: string;
  developerPrompt?: string;
  reviewerPrompt?: string;
  configRevision?: string;
}

export interface StartRunRequest { maxStories: number; autoMerge: boolean; expectedConfigRevision?: string; selectionMode?: "selected" | "auto"; storyId?: string; }
export interface DecisionRequest { decision: "APPROVE" | "REJECT" | "DEFER"; reason?: string; expectedHeadSha?: string; expectedSpecRevision?: string; idempotencyKey: string; }
export interface DecisionResult { accepted: boolean; decisionId?: string; requestId: string; status: ApprovalRequest["status"]; message: string; executionStatus: "PENDING" | "APPLIED" | "FAILED"; }
export interface InstructionRequest { content: string; expectedRunStatus: ExecutionStatus; idempotencyKey: string; }
export interface InstructionResult { instructionId: string; runId: string; storyId?: string; status: "PENDING_NEXT_INVOCATION"; receivedAt: string; appliedAt?: string; }
export interface SpecUpdateRequest { markdown: string; expectedRevision: string; confirm: boolean; idempotencyKey: string; }
export interface ConfigUpdateRequest { config: Partial<AppConfigView>; expectedRevision: string; idempotencyKey: string; }

export class ContractValidationError extends Error {
  constructor(public readonly field: string, message: string) { super(message); }
}

export function parseStartRunRequest(value: unknown): StartRunRequest {
  if (!isRecord(value) || !positiveInteger(value.maxStories) || typeof value.autoMerge !== "boolean") throw new ContractValidationError("run", "maxStories must be a positive integer and autoMerge must be boolean");
  const expectedConfigRevision = optionalString(value.expectedConfigRevision);
  const selectionMode = value.selectionMode === undefined ? "auto" : value.selectionMode;
  const storyId = optionalString(value.storyId);
  if (!["selected", "auto"].includes(String(selectionMode)) || (selectionMode === "selected" && !storyId)) throw new ContractValidationError("run.selection", "selected mode requires storyId; otherwise use auto");
  return { maxStories: value.maxStories, autoMerge: value.autoMerge, selectionMode: selectionMode as "selected" | "auto", storyId, ...(expectedConfigRevision ? { expectedConfigRevision } : {}) };
}

export function parseSelectProjectRequest(value: unknown): SelectProjectRequest {
  if (!isRecord(value) || typeof value.targetPath !== "string" || !value.targetPath.trim() || value.targetPath.length > 4_096) throw new ContractValidationError("targetPath", "targetPath must be a non-empty directory path");
  return { targetPath: value.targetPath.trim() };
}

export function parseInitProjectRequest(value: unknown): InitProjectRequest {
  if (!isRecord(value) || typeof value.targetPath !== "string" || !value.targetPath.trim() || typeof value.confirmationPath !== "string" || !value.confirmationPath.trim()) throw new ContractValidationError("project", "targetPath and the exact confirmationPath are required");
  return { targetPath: value.targetPath.trim(), confirmationPath: value.confirmationPath.trim() };
}

export function parseBacklogSyncRequest(value: unknown): BacklogSyncRequest {
  if (!isRecord(value) || typeof value.previewId !== "string" || !value.previewId || !Array.isArray(value.resolutions)) throw new ContractValidationError("sync", "previewId and resolutions are required");
  const resolutions = value.resolutions.map((item) => {
    if (!isRecord(item) || typeof item.storyId !== "string" || !item.storyId || !["USE_LOCAL", "KEEP_REMOTE"].includes(String(item.decision))) throw new ContractValidationError("sync.resolutions", "each resolution requires storyId and USE_LOCAL or KEEP_REMOTE");
    return { storyId: item.storyId, decision: item.decision as "USE_LOCAL" | "KEEP_REMOTE" };
  });
  return { previewId: value.previewId, resolutions };
}

export function parseDecisionRequest(value: unknown): DecisionRequest {
  if (!isRecord(value) || !["APPROVE", "REJECT", "DEFER"].includes(String(value.decision)) || typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 1 || (value.decision === "REJECT" && !optionalString(value.reason))) throw new ContractValidationError("decision", "decision, idempotencyKey, and a rejection reason are required");
  return { decision: value.decision as DecisionRequest["decision"], reason: optionalString(value.reason), expectedHeadSha: optionalString(value.expectedHeadSha), expectedSpecRevision: optionalString(value.expectedSpecRevision), idempotencyKey: value.idempotencyKey };
}

export function parseInstructionRequest(value: unknown): InstructionRequest {
  if (!isRecord(value) || typeof value.content !== "string" || value.content.trim().length < 1 || value.content.length > 10_000 || typeof value.expectedRunStatus !== "string" || !["PAUSED", "PAUSE_REQUESTED", "STOPPED", "INTERRUPTED", "BLOCKED"].includes(value.expectedRunStatus) || typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 1) throw new ContractValidationError("instruction", "content, paused/stopped/blocked status, and idempotencyKey are required");
  return { content: value.content.trim(), expectedRunStatus: value.expectedRunStatus as InstructionRequest["expectedRunStatus"], idempotencyKey: value.idempotencyKey };
}

export function parseSpecUpdateRequest(value: unknown): SpecUpdateRequest {
  if (!isRecord(value) || typeof value.markdown !== "string" || value.markdown.length > 200_000 || typeof value.expectedRevision !== "string" || !value.expectedRevision || typeof value.confirm !== "boolean" || typeof value.idempotencyKey !== "string" || !value.idempotencyKey) throw new ContractValidationError("spec", "markdown, expectedRevision, confirm, and idempotencyKey are required");
  return { markdown: value.markdown, expectedRevision: value.expectedRevision, confirm: value.confirm, idempotencyKey: value.idempotencyKey };
}

export function parseConfigUpdateRequest(value: unknown): ConfigUpdateRequest {
  if (!isRecord(value) || !isRecord(value.config) || typeof value.expectedRevision !== "string" || !value.expectedRevision || typeof value.idempotencyKey !== "string" || !value.idempotencyKey) throw new ContractValidationError("config", "config, expectedRevision, and idempotencyKey are required");
  const config = value.config; const allowed = ["owner", "repo", "baseBranch", "controlRepository", "targetRepository", "targetBranch", "targetBacklogPath", "targetWorkspace", "model", "modelVersion", "developerModel", "developerReasoning", "reviewerModel", "reviewerReasoning", "validationCommands", "requiredChecks", "maxStories", "maxFixCycles", "maxValidationAttempts", "autoMerge", "stateFile", "developerPrompt", "reviewerPrompt"];
  for (const key of Object.keys(config)) if (!allowed.includes(key) || /token|password|secret|credential|auth/i.test(key)) throw new ContractValidationError(`config.${key}`, "field is not editable");
  if (config.maxStories !== undefined && (!Number.isInteger(config.maxStories) || Number(config.maxStories) < 1 || Number(config.maxStories) > 100)) throw new ContractValidationError("config.maxStories", "must be an integer between 1 and 100");
  if (config.maxFixCycles !== undefined && (!Number.isInteger(config.maxFixCycles) || Number(config.maxFixCycles) < 1 || Number(config.maxFixCycles) > 20)) throw new ContractValidationError("config.maxFixCycles", "must be an integer between 1 and 20");
  if (config.maxValidationAttempts !== undefined && (!Number.isInteger(config.maxValidationAttempts) || Number(config.maxValidationAttempts) < 1 || Number(config.maxValidationAttempts) > 20)) throw new ContractValidationError("config.maxValidationAttempts", "must be an integer between 1 and 20");
  for (const key of ["validationCommands", "requiredChecks"] as const) if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== "string" || item.length > 500))) throw new ContractValidationError(`config.${key}`, "must be an array of strings");
  for (const key of ["owner", "repo", "baseBranch", "controlRepository", "targetRepository", "targetBranch", "targetBacklogPath", "targetWorkspace", "model", "modelVersion", "stateFile", "developerPrompt", "reviewerPrompt"] as const) if (config[key] !== undefined && typeof config[key] !== "string") throw new ContractValidationError(`config.${key}`, "must be a string");
  if (config.modelVersion !== undefined && !/^gpt-\d+(?:\.\d+)+$/.test(String(config.modelVersion))) throw new ContractValidationError("config.modelVersion", "must use the gpt-X.Y format, for example gpt-5.6");
  if (config.autoMerge !== undefined && typeof config.autoMerge !== "boolean") throw new ContractValidationError("config.autoMerge", "must be boolean");
  for (const key of ["developerModel", "reviewerModel"] as const) if (config[key] !== undefined && !["luna", "sol", "terra"].includes(String(config[key]))) throw new ContractValidationError(`config.${key}`, "must be luna, sol, or terra");
  for (const key of ["developerReasoning", "reviewerReasoning"] as const) if (config[key] !== undefined && !["low", "medium", "high", "xhigh"].includes(String(config[key]))) throw new ContractValidationError(`config.${key}`, "must be low, medium, high, or xhigh");
  return { config: config as Partial<AppConfigView>, expectedRevision: value.expectedRevision, idempotencyKey: value.idempotencyKey };
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
