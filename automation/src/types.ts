export type StoryStatus =
  | "READY"
  | "IMPLEMENTING"
  | "PR_OPEN"
  | "VERIFYING"
  | "REVIEWING"
  | "REVIEW_APPROVED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_FAILED"
  | "QUEUED_FOR_REVIEW"
  | "READY_FOR_MERGE"
  | "MERGE_PENDING_APPROVAL"
  | "MERGE_FAILED"
  | "FIXING"
  | "MERGED"
  | "DONE"
  | "NEEDS_HUMAN"
  | "PAUSED_AUTH"
  | "PAUSED_QUOTA"
  | "FAILED_INFRA";

export interface StoryContract {
  objective: string;
  acceptanceCriteria: string[];
  scope: string;
  dependencies: number[];
  priority: number;
  validation: string[];
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

export interface PullRequest {
  number: number;
  title: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  state: "open" | "closed";
  merged: boolean;
  body: string;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  headSha: string;
}

export interface ReviewResult {
  decision: "PASS" | "CHANGES_REQUESTED" | "NEEDS_HUMAN";
  findings: string[];
  evidence: string[];
}

export interface OrchestrationConfig {
  owner: string;
  repo: string;
  baseBranch: string;
  controlRepository?: string;
  targetRepository: string;
  targetBranch: string;
  targetBacklogPath: string;
  targetWorkspace?: string;
  runnerLabel: string;
  model?: string;
  validationCommands: string[];
  smokeCommands: string[];
  requiredChecks: string[];
  timeouts: {
    codexMinutes: number;
    ciMinutes: number;
    workflowMinutes: number;
  };
  maxStories: number;
  maxFixCycles: number;
  autoMerge: boolean;
  stateFile: string;
  logDirectory: string;
  /** Optional repository-relative prefixes allowed for a story change. */
  allowedChangePaths?: string[];
  runId?: string;
}

export interface StoryState {
  issueNumber: number;
  status: StoryStatus;
  branch: string;
  pullRequestNumber?: number;
  headSha?: string;
  fixCycles: number;
  reviewHeadSha?: string;
  updatedAt: string;
  reason?: string;
  startedAt?: string;
  processStatus?: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
  validation?: Array<{ command: string; passed: boolean; output: string }>;
  changedFiles?: string[];
  sourceIssueUrl?: string;
  pullRequestUrl?: string;
  reviewerStatus?: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "LOST";
  reviewerStartedAt?: string;
  reviewerFinishedAt?: string;
  reviewSha?: string;
  reviewFindings?: string[];
  reviewEvidence?: string[];
  reviewPublicationKey?: string;
  reviewUrl?: string;
  attemptId?: string;
  fixerStatus?: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "LOST";
  findingDispositions?: Record<string, "FIXED" | "NOT_APPLICABLE" | "NEEDS_HUMAN">;
}

export interface PersistedState {
  stories: Record<string, StoryState>;
}

export interface CodexExecution {
  exitCode: number | null;
  output: string;
  errorOutput: string;
  result?: unknown;
}
