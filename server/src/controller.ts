import { randomUUID } from "node:crypto";
import type { ApprovalRequest, AppConfigView, Diagnostic, LogEntry, ProjectSnapshot, RunSnapshot, StartRunRequest, StoryDetail, StorySummary } from "@ai-factory/contracts";
import { SCHEMA_VERSION } from "@ai-factory/contracts";
import { AgentPersistence } from "./persistence.js";
import { loadRepositoryStories } from "./stories.js";

type Listener = (event: LogEntry) => void;

export class LocalController {
  private readonly listeners = new Set<Listener>();
  private activeRun?: RunSnapshot;
  private readonly approvalItems: ApprovalRequest[] = [];
  private stories: StoryDetail[] = [];
  private storiesLoaded = false;
  private readonly config: AppConfigView = { owner: "OWNER", repo: "REPO", baseBranch: "main", validationCommands: [], requiredChecks: [], maxStories: 1, maxFixCycles: 3, autoMerge: false, stateFile: ".agent/state.json" };
  constructor(private readonly persistence = new AgentPersistence(), private readonly options: { codexAvailable?: boolean; githubConnected?: boolean; backlogRoot?: string } = {}) {}

  async project(): Promise<ProjectSnapshot> {
    await this.ensureStories();
    const diagnostics: Diagnostic[] = [
      { name: "controller", available: true, message: "local controller ready" },
      { name: "github", available: this.options.githubConnected === true, message: this.options.githubConnected === true ? "adapter connected" : "No GitHub adapter configured" },
      { name: "codex", available: this.options.codexAvailable !== false, message: this.options.codexAvailable === false ? "Codex executable is not available" : "available through the configured runner" },
    ];
    const githubConnected = this.options.githubConnected === true;
    const codexAvailable = this.options.codexAvailable !== false;
    return { schemaVersion: SCHEMA_VERSION, repository: { owner: this.config.owner, repo: this.config.repo, baseBranch: this.config.baseBranch }, controller: { available: true, version: "ui-v1" }, github: { connected: githubConnected, stale: !githubConnected, message: githubConnected ? undefined : "No GitHub adapter configured" }, codex: { available: codexAvailable, message: codexAvailable ? undefined : "Codex executable is not available" }, activeRunId: this.activeRun?.runId, counts: { total: this.stories.length, done: this.stories.filter((story) => story.deliveryStatus === "MERGED").length, blocked: this.stories.filter((story) => Boolean(story.blockedReason)).length, active: this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status) ? 1 : 0 }, diagnostics };
  }
  async listStories(query?: { search?: string; status?: string }): Promise<StorySummary[]> {
    await this.ensureStories();
    const search = query?.search?.trim().toLowerCase();
    return this.stories.filter((story) => !search || `${story.storyId} ${story.title} ${story.objective}`.toLowerCase().includes(search)).filter((story) => !query?.status || query.status === "all" || statusFor(story) === query.status).map((story) => ({ storyId: story.storyId, title: story.title, priority: story.priority, dependencies: story.dependencies, deliveryStatus: story.deliveryStatus, executionStatus: story.executionStatus, validationStatus: story.validationStatus, specSource: story.specSource, specRevision: story.specRevision, githubIssueNumber: story.githubIssueNumber, pullRequestNumber: story.pullRequestNumber, headSha: story.headSha, blockedReason: story.blockedReason, dependencyError: story.dependencyError, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber), updatedAt: story.updatedAt }));
  }
  async story(storyId: string): Promise<StoryDetail | undefined> { await this.ensureStories(); const story = this.stories.find((item) => item.storyId === storyId); return story ? { ...story, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber) } : undefined; }
  async runs(): Promise<RunSnapshot[]> { return this.activeRun ? [this.activeRun] : []; }
  async run(runId: string): Promise<RunSnapshot | undefined> { return this.activeRun?.runId === runId ? this.activeRun : this.persistence.readSnapshot(runId); }
  async logs(runId: string): Promise<LogEntry[]> { return this.persistence.readEvents(runId); }
  async approvals(): Promise<ApprovalRequest[]> { return this.approvalItems; }
  async configView(): Promise<AppConfigView & { revision: string }> { return { ...this.config, revision: "local-config-v1" }; }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async start(request: StartRunRequest): Promise<RunSnapshot> {
    if (this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status)) throw new Error("RUN_ALREADY_ACTIVE");
    const now = new Date().toISOString();
    this.activeRun = { schemaVersion: SCHEMA_VERSION, runId: randomUUID(), status: "ACTIVE", phase: "SELECTING", startedAt: now, updatedAt: now, attempts: 0, maxStories: request.maxStories, autoMerge: request.autoMerge, validationStatus: "PENDING", effectiveConfigRevision: "local-config-v1" };
    await this.persist("run started");
    return this.activeRun;
  }
  async control(runId: string, action: "pause" | "stop" | "resume"): Promise<RunSnapshot> {
    if (!this.activeRun || this.activeRun.runId !== runId) throw new Error("RUN_NOT_FOUND");
    if (action === "pause" && this.activeRun.status === "ACTIVE") this.activeRun = { ...this.activeRun, status: "PAUSE_REQUESTED", pauseRequested: true, phase: "PAUSED", updatedAt: new Date().toISOString() };
    else if (action === "stop" && !["FINISHED", "STOPPED"].includes(this.activeRun.status)) this.activeRun = { ...this.activeRun, status: "STOP_REQUESTED", stopRequested: true, phase: "STOPPED", updatedAt: new Date().toISOString() };
    else if (action === "resume" && ["PAUSED", "STOPPED", "INTERRUPTED", "STOP_REQUESTED", "PAUSE_REQUESTED"].includes(this.activeRun.status)) this.activeRun = { ...this.activeRun, status: "ACTIVE", phase: "SELECTING", pauseRequested: false, stopRequested: false, updatedAt: new Date().toISOString() };
    await this.persist(`run ${action} requested`);
    return this.activeRun;
  }
  private async persist(message: string): Promise<void> { if (!this.activeRun) return; await this.persistence.writeSnapshot(this.activeRun.runId, this.activeRun); const event: LogEntry = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId: this.activeRun.runId, sequence: (await this.persistence.readEvents(this.activeRun.runId)).length + 1, timestamp: new Date().toISOString(), source: "controller", phase: this.activeRun.phase, level: "INFO", message }; await this.persistence.appendEvent(this.activeRun.runId, event); for (const listener of this.listeners) listener(event); }

  private async ensureStories(): Promise<void> { if (this.storiesLoaded) return; this.stories = await loadRepositoryStories(this.options.backlogRoot); this.storiesLoaded = true; }
}

function statusFor(story: StoryDetail): "pending" | "active" | "blocked" | "done" { if (story.deliveryStatus === "MERGED") return "done"; if (story.dependencyError || story.blockedReason) return "blocked"; if (["ACTIVE", "PAUSE_REQUESTED", "PAUSED", "STOP_REQUESTED"].includes(story.executionStatus)) return "active"; return "pending"; }
function issueUrl(config: AppConfigView, issue?: number): string | undefined { return issue ? `https://github.com/${config.owner}/${config.repo}/issues/${issue}` : undefined; }
function pullRequestUrl(config: AppConfigView, pullRequest?: number): string | undefined { return pullRequest ? `https://github.com/${config.owner}/${config.repo}/pull/${pullRequest}` : undefined; }
