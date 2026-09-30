export const SCHEMA_VERSION = 1;

export type DeliveryStatus = "NOT_STARTED" | "IMPLEMENTING" | "PR_OPEN" | "MERGED";
export type ExecutionStatus = "IDLE" | "ACTIVE" | "PAUSE_REQUESTED" | "PAUSED" | "STOP_REQUESTED" | "STOPPED" | "FINISHED" | "INTERRUPTED" | "BLOCKED";
export type ValidationStatus = "PENDING" | "PASS" | "FAIL" | "UNKNOWN" | "STALE";
export type RunPhase = "SELECTING" | "IMPLEMENTING" | "TESTING" | "CI" | "REVIEWING" | "FIXING" | "MERGING" | "PAUSED" | "STOPPED" | "FINISHED";

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
}

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
}

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
  source: "controller" | "developer" | "reviewer" | "git" | "github" | "validation";
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
  model?: string;
  validationCommands: string[];
  requiredChecks: string[];
  maxStories: number;
  maxFixCycles: number;
  autoMerge: boolean;
  stateFile: string;
}

export interface StartRunRequest { maxStories: number; autoMerge: boolean; expectedConfigRevision?: string; }
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
  return expectedConfigRevision ? { maxStories: value.maxStories, autoMerge: value.autoMerge, expectedConfigRevision } : { maxStories: value.maxStories, autoMerge: value.autoMerge };
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

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
