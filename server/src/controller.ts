import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ApprovalRequest, AppConfigView, BacklogValidation, ConfigUpdateRequest, DecisionRequest, DecisionResult, Diagnostic, GithubObservation, InstructionRequest, InstructionResult, LogEntry, LogPage, ProjectSnapshot, RunSnapshot, SpecUpdateRequest, StartRunRequest, StoryDetail, StoryDiagnostic, StorySummary, SyncResult } from "@ai-factory/contracts";
import { SCHEMA_VERSION } from "@ai-factory/contracts";
import { AgentPersistence } from "./persistence.js";
import { BACKLOG_STORY_TEMPLATE, loadBacklog } from "./stories.js";
import { loadAppConfig, configFilePath } from "./config.js";

type Listener = (event: LogEntry) => void;
export interface GithubSyncAdapter { observe(stories: StoryDetail[]): Promise<GithubObservation[]>; }

interface OrchestratorStoryState { issueNumber: number; branch: string; status: string; fixCycles?: number; pullRequestNumber?: number; headSha?: string; reason?: string; updatedAt: string; }
interface OrchestratorState { stories?: Record<string, OrchestratorStoryState>; }

export class LocalController {
  private readonly listeners = new Set<Listener>();
  private activeRun?: RunSnapshot;
  private readonly approvalItems: ApprovalRequest[];
  private readonly decisions = new Map<string, DecisionResult>();
  private readonly instructions = new Map<string, InstructionResult>();
  private stories: StoryDetail[] = [];
  private storyDiagnostics: StoryDiagnostic[] = [];
  private storiesLoaded = false;
  private runHistory: RunSnapshot[] = [];
  private runsLoaded = false;
  private config: AppConfigView;
  private configRevision = "local-config-v1";
  private lastSyncAt?: string;
  private syncStale = true;
  private githubConnected = false;
  private readonly configUpdates = new Map<string, { revision: string; config: AppConfigView; diff: string }>();
  constructor(private readonly persistence = new AgentPersistence(), private readonly options: { codexAvailable?: boolean; githubConnected?: boolean; githubObservations?: GithubObservation[]; githubAdapter?: GithubSyncAdapter; backlogRoot?: string; orchestratorStatePath?: string; approvals?: ApprovalRequest[]; configPath?: string } = {}) { this.config = loadAppConfig(options.configPath); this.githubConnected = options.githubConnected === true || Boolean(options.githubAdapter); this.approvalItems = options.approvals ? options.approvals.map((item) => ({ ...item })) : []; }

  async project(): Promise<ProjectSnapshot> {
    await this.ensureStories();
    await this.refreshOrchestratorState();
    await this.ensureRuns();
    const diagnostics: Diagnostic[] = [
      { name: "controller", available: true, message: "local controller ready" },
      { name: "backlog", available: !this.storyDiagnostics.some((item) => item.severity === "ERROR"), message: this.storyDiagnostics.length ? `${this.storyDiagnostics.filter((item) => item.severity === "ERROR").length} error(s), ${this.storyDiagnostics.filter((item) => item.severity === "WARNING").length} warning(s)` : "valid" },
      { name: "github", available: this.githubConnected, message: this.githubConnected ? "adapter connected" : "No GitHub adapter configured" },
      { name: "codex", available: this.options.codexAvailable !== false, message: this.options.codexAvailable === false ? "Codex executable is not available" : "available through the configured runner" },
    ];
    const githubConnected = this.githubConnected;
    const codexAvailable = this.options.codexAvailable !== false;
    const live = this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status) ? this.activeRun : undefined;
    const externalActive = this.stories.some((story) => ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(story.executionStatus));
    return { schemaVersion: SCHEMA_VERSION, repository: { owner: this.config.owner, repo: this.config.repo, baseBranch: this.config.baseBranch }, controller: { available: true, version: "ui-v1" }, github: { connected: githubConnected, checkedAt: this.lastSyncAt, stale: this.syncStale, message: githubConnected ? undefined : "No GitHub adapter configured" }, codex: { available: codexAvailable, message: codexAvailable ? undefined : "Codex executable is not available" }, activeRunId: live?.runId, counts: { total: this.stories.length, done: this.stories.filter((story) => story.deliveryStatus === "MERGED").length, blocked: this.stories.filter((story) => Boolean(story.blockedReason)).length, active: live ? 1 : externalActive ? 1 : 0 }, lastSyncAt: this.lastSyncAt, diagnostics };
  }
  async listStories(query?: { search?: string; status?: string }): Promise<StorySummary[]> {
    await this.ensureStories();
    await this.refreshOrchestratorState();
    const search = query?.search?.trim().toLowerCase();
    return this.stories.filter((story) => !search || `${story.storyId} ${story.title} ${story.objective}`.toLowerCase().includes(search)).filter((story) => !query?.status || query.status === "all" || statusFor(story) === query.status).map((story) => ({ storyId: story.storyId, title: story.title, priority: story.priority, dependencies: story.dependencies, deliveryStatus: story.deliveryStatus, executionStatus: story.executionStatus, validationStatus: story.validationStatus, specSource: story.specSource, specRevision: story.specRevision, githubIssueNumber: story.githubIssueNumber, pullRequestNumber: story.pullRequestNumber, headSha: story.headSha, validatedHeadSha: story.validatedHeadSha, externalStatus: story.externalStatus, externalStale: story.externalStale, blockedReason: story.blockedReason, dependencyError: story.dependencyError, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber), updatedAt: story.updatedAt, agentStatus: story.agentStatus, agentReason: story.agentReason, branch: story.branch, sourceFile: story.sourceFile, valid: story.valid, diagnostics: story.diagnostics }));
  }
  async backlogValidation(): Promise<BacklogValidation> { await this.ensureStories(); return { valid: !this.storyDiagnostics.some((item) => item.severity === "ERROR"), diagnostics: [...this.storyDiagnostics], template: BACKLOG_STORY_TEMPLATE }; }
  async story(storyId: string): Promise<StoryDetail | undefined> { await this.ensureStories(); await this.refreshOrchestratorState(); const story = this.stories.find((item) => item.storyId === storyId); return story ? { ...story, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber) } : undefined; }
  async runs(): Promise<RunSnapshot[]> { await this.ensureRuns(); await this.ensureStories(); await this.refreshOrchestratorState(); return [...this.externalRuns(), ...this.runHistory]; }
  async run(runId: string): Promise<RunSnapshot | undefined> { await this.ensureRuns(); return this.runHistory.find((run) => run.runId === runId) || this.persistence.readSnapshot(runId); }
  async logs(runId: string, options: { cursor?: number; limit?: number; level?: LogEntry["level"]; source?: LogEntry["source"]; search?: string } = {}): Promise<LogPage> { return this.persistence.readEventsPage(runId, options); }
  async eventsSince(cursor = 0): Promise<LogEntry[]> { await this.ensureRuns(); const events: LogEntry[] = []; for (const run of this.runHistory) events.push(...await this.persistence.readEvents(run.runId)); return events.filter((event) => event.sequence > cursor).sort((left, right) => left.timestamp.localeCompare(right.timestamp)); }
  async approvals(): Promise<ApprovalRequest[]> { return this.approvalItems; }
  async decideApproval(requestId: string, request: DecisionRequest): Promise<DecisionResult> {
    const previous = this.decisions.get(request.idempotencyKey); if (previous) return previous;
    const approval = this.approvalItems.find((item) => item.requestId === requestId);
    if (!approval) throw new Error("APPROVAL_NOT_FOUND");
    if (approval.status !== "PENDING") throw new Error("APPROVAL_ALREADY_DECIDED");
    if (request.decision === "REJECT" && !request.reason?.trim()) throw new Error("rejection reason required");
    if ((approval.expectedHeadSha && approval.expectedHeadSha !== request.expectedHeadSha) || (approval.expectedSpecRevision && approval.expectedSpecRevision !== request.expectedSpecRevision)) throw new Error("STALE_APPROVAL");
    if (approval.type === "MERGE" && request.decision === "APPROVE" && approval.evidence.some((item) => /(ci|check|test).*(fail|pending)|(fail|pending).*(ci|check|test)/i.test(item))) throw new Error("MERGE_CHECKS_NOT_PASSING");
    const now = new Date().toISOString();
    if (request.decision === "DEFER") { approval.status = "DEFERRED"; approval.decidedAt = now; approval.reason = request.reason; const result: DecisionResult = { accepted: true, requestId, status: "DEFERRED", message: "Decision deferred; the run remains blocked.", executionStatus: "PENDING" }; this.decisions.set(request.idempotencyKey, result); await this.persistence.appendDecision(approval.runId, { schemaVersion: 1, requestId, action: "DEFER", actor: "local-user", createdAt: now }); return result; }
    approval.status = request.decision === "APPROVE" ? "APPROVED" : "REJECTED"; approval.decidedAt = now; approval.reason = request.reason;
    const result: DecisionResult = { accepted: true, decisionId: randomUUID(), requestId, status: approval.status, message: request.decision === "APPROVE" ? (approval.type === "MERGE" ? "Approval recorded; GitHub checks and native review still apply." : "Approval recorded; the controller may continue at the next safe point.") : "Rejection recorded; the run remains blocked.", executionStatus: "PENDING" };
    this.decisions.set(request.idempotencyKey, result); await this.persistence.appendDecision(approval.runId, { schemaVersion: 1, decisionId: result.decisionId, requestId, decision: request.decision, actor: "local-user", reason: request.reason, expectedHeadSha: request.expectedHeadSha, expectedSpecRevision: request.expectedSpecRevision, createdAt: now, executionStatus: "PENDING" }); return result;
  }
  async addInstruction(runId: string, request: InstructionRequest): Promise<InstructionResult> {
    const previous = this.instructions.get(request.idempotencyKey); if (previous) return previous;
    await this.ensureRuns(); const run = this.runHistory.find((item) => item.runId === runId); if (!run) throw new Error("RUN_NOT_FOUND");
    if (run.status !== request.expectedRunStatus) throw new Error("RUN_CONTEXT_CHANGED");
    const result: InstructionResult = { instructionId: randomUUID(), runId, storyId: run.storyId, status: "PENDING_NEXT_INVOCATION", receivedAt: new Date().toISOString() };
    this.instructions.set(request.idempotencyKey, result); await this.persistence.appendInstruction(runId, { ...result, content: request.content, expectedRunStatus: request.expectedRunStatus }); return result;
  }
  async updateStorySpec(storyId: string, request: SpecUpdateRequest): Promise<{ preview: boolean; diff: string; revision?: string }> {
    if (!/^[A-Za-z0-9._-]+$/.test(storyId)) throw new Error("PERMISSION_DENIED");
    await this.ensureStories(); const story = this.stories.find((item) => item.storyId === storyId); if (!story) throw new Error("STORY_NOT_FOUND");
    if (story.specRevision !== request.expectedRevision) throw new Error("VERSION_CONFLICT");
    if (["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(story.executionStatus)) throw new Error("SPEC_EDIT_REQUIRES_PAUSE");
    const diff = unifiedDiff(story.markdown, request.markdown);
    if (!request.confirm) return { preview: true, diff };
    const root = resolve(this.options.backlogRoot || "backlog"); const path = resolve(root, story.sourceFile || `${storyId}.md`); if (dirname(path) !== root) throw new Error("PERMISSION_DENIED");
    await writeFile(path, request.markdown, "utf8"); const revision = createHash("sha256").update(request.markdown).digest("hex").slice(0, 12); this.stories = this.stories.map((item) => item.storyId === storyId ? { ...item, markdown: request.markdown, specRevision: revision, updatedAt: new Date().toISOString() } : item); return { preview: false, diff, revision };
  }
  async updateConfig(request: ConfigUpdateRequest): Promise<{ revision: string; config: AppConfigView; diff: string }> {
    const previous = this.configUpdates.get(request.idempotencyKey); if (previous) return previous;
    if (request.expectedRevision !== this.configRevision) throw new Error("VERSION_CONFLICT");
    const next = { ...this.config, ...request.config }; const diff = unifiedDiff(JSON.stringify(this.config, null, 2), JSON.stringify(next, null, 2));
    const path = configFilePath(this.options.configPath); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8"); await rename(temp, path);
    this.config = next; this.configRevision = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 12); const result = { revision: this.configRevision, config: { ...this.config }, diff }; this.configUpdates.set(request.idempotencyKey, result); return result;
  }
  async sync(): Promise<SyncResult> {
    await this.ensureStories();
    this.assertValidBacklog();
    if (!this.options.githubAdapter && this.options.githubConnected !== true) { this.githubConnected = false; this.syncStale = true; return { connected: false, stale: true, message: "GitHub unavailable; remote facts were not changed", changedStoryIds: [] }; }
    let observations: GithubObservation[];
    try { observations = this.options.githubAdapter ? await this.options.githubAdapter.observe(this.stories) : this.options.githubObservations || []; this.githubConnected = true; } catch (error) { this.githubConnected = false; this.syncStale = true; return { connected: false, stale: true, message: error instanceof Error ? error.message : "GitHub unavailable; remote facts were not changed", changedStoryIds: [] }; }
    const changedStoryIds: string[] = [];
    this.stories = this.stories.map((story) => {
      const observation = observations.find((item) => item.storyId === story.storyId); if (!observation) return story;
      const changed = observation.headSha !== story.headSha || observation.state !== story.externalStatus || observation.checks === "FAIL";
      if (changed) changedStoryIds.push(story.storyId);
      const pushed = Boolean(story.headSha && observation.headSha && story.headSha !== observation.headSha);
      const validationStatus = pushed ? "STALE" : observation.checks === "PASS" && observation.headSha && observation.validatedHeadSha === observation.headSha ? "PASS" : observation.checks === "FAIL" ? "FAIL" : observation.checks === "PENDING" ? "PENDING" : "UNKNOWN";
      return { ...story, githubIssueNumber: observation.githubIssueNumber || story.githubIssueNumber, pullRequestNumber: observation.pullRequestNumber || story.pullRequestNumber, headSha: observation.headSha || story.headSha, validatedHeadSha: observation.validatedHeadSha, externalStatus: observation.state, externalStale: false, validationStatus, deliveryStatus: observation.state === "MERGED" ? "MERGED" : story.deliveryStatus === "MERGED" ? "MERGED" : observation.pullRequestNumber ? "PR_OPEN" : story.deliveryStatus, updatedAt: observation.checkedAt };
    });
    await this.refreshOrchestratorState(); this.lastSyncAt = new Date().toISOString(); this.syncStale = false; return { connected: true, stale: false, syncedAt: this.lastSyncAt, message: changedStoryIds.length ? `Reconciled ${changedStoryIds.length} story(ies)` : "Remote state is already current", changedStoryIds };
  }
  async history(): Promise<Array<{ runId: string; timestamp: string; message: string; phase: string }>> { await this.ensureRuns(); const entries: Array<{ runId: string; timestamp: string; message: string; phase: string }> = []; for (const run of this.runHistory) for (const event of await this.persistence.readEvents(run.runId)) entries.push({ runId: run.runId, timestamp: event.timestamp, message: event.message, phase: event.phase }); return entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp)); }
  async configView(): Promise<AppConfigView & { revision: string }> { return { ...this.config, revision: this.configRevision }; }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async start(request: StartRunRequest): Promise<RunSnapshot> {
    await this.ensureStories();
    this.assertValidBacklog();
    await this.ensureRuns();
    if (this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status)) throw new Error("RUN_ALREADY_ACTIVE");
    const now = new Date().toISOString();
    const story = this.stories.find((item) => item.deliveryStatus !== "MERGED" && !item.dependencyError);
    this.activeRun = { schemaVersion: SCHEMA_VERSION, runId: randomUUID(), storyId: story?.storyId, status: "ACTIVE", phase: "SELECTING", startedAt: now, updatedAt: now, attempts: 0, maxStories: request.maxStories, autoMerge: request.autoMerge, validationStatus: "PENDING", effectiveConfigRevision: this.configRevision };
    if (story) this.stories = this.stories.map((item) => item.storyId === story.storyId ? { ...item, executionStatus: "ACTIVE", updatedAt: now } : item);
    await this.persist("run started");
    return this.activeRun;
  }
  async control(runId: string, action: "pause" | "stop" | "resume"): Promise<RunSnapshot> {
    await this.ensureRuns();
    if (!this.activeRun) this.activeRun = this.runHistory.find((run) => run.runId === runId);
    if (!this.activeRun || this.activeRun.runId !== runId) throw new Error("RUN_NOT_FOUND");
    if (action === "pause" && this.activeRun.status === "ACTIVE") this.activeRun = { ...this.activeRun, status: "PAUSE_REQUESTED", pauseRequested: true, updatedAt: new Date().toISOString() };
    else if (action === "stop" && !["FINISHED", "STOPPED"].includes(this.activeRun.status)) this.activeRun = { ...this.activeRun, status: "STOP_REQUESTED", stopRequested: true, phase: "STOPPED", updatedAt: new Date().toISOString() };
    else if (action === "resume" && ["PAUSED", "STOPPED", "INTERRUPTED", "STOP_REQUESTED", "PAUSE_REQUESTED"].includes(this.activeRun.status)) this.activeRun = { ...this.activeRun, status: "ACTIVE", phase: "SELECTING", pauseRequested: false, stopRequested: false, updatedAt: new Date().toISOString() };
    await this.persist(`run ${action} requested`);
    return this.activeRun;
  }
  private async persist(message: string): Promise<void> { if (!this.activeRun) return; await this.persistence.writeSnapshot(this.activeRun.runId, this.activeRun); this.runHistory = [this.activeRun, ...this.runHistory.filter((run) => run.runId !== this.activeRun?.runId)]; const event: LogEntry = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId: this.activeRun.runId, sequence: (await this.persistence.readEvents(this.activeRun.runId)).length + 1, timestamp: new Date().toISOString(), source: "controller", phase: this.activeRun.phase, level: "INFO", message }; await this.persistence.appendEvent(this.activeRun.runId, event); for (const listener of this.listeners) listener(event); }

  private async ensureStories(): Promise<void> { if (this.storiesLoaded) return; const backlog = await loadBacklog(this.options.backlogRoot); this.stories = backlog.stories; this.storyDiagnostics = backlog.diagnostics; this.storiesLoaded = true; }
  private assertValidBacklog(): void { const first = this.storyDiagnostics.find((item) => item.severity === "ERROR"); if (first) throw new Error(`BACKLOG_INVALID: ${first.file}:${first.line} ${first.message}`); }
  private async refreshOrchestratorState(): Promise<void> {
    if (!this.options.orchestratorStatePath) return;
    let parsed: OrchestratorState;
    try { parsed = JSON.parse(await readFile(resolve(this.options.orchestratorStatePath), "utf8")) as OrchestratorState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; return; }
    const states = Object.values(parsed.stories || {});
    this.stories = this.stories.map((story) => {
      const state = states.find((item) => item.issueNumber === story.githubIssueNumber);
      if (!state) return story;
      const active = ["IMPLEMENTING", "FIXING", "REVIEWING", "PR_OPEN"].includes(state.status);
      const blocked = ["FAILED_INFRA", "NEEDS_HUMAN", "PAUSED_AUTH", "PAUSED_QUOTA"].includes(state.status);
      return { ...story, executionStatus: active ? "ACTIVE" : blocked ? "BLOCKED" : state.status === "DONE" ? "FINISHED" : story.executionStatus, deliveryStatus: state.status === "PR_OPEN" ? "PR_OPEN" : state.status === "DONE" ? "MERGED" : active ? "IMPLEMENTING" : story.deliveryStatus, blockedReason: blocked ? state.reason || state.status : story.blockedReason, branch: state.branch, agentStatus: state.status, agentReason: state.reason, pullRequestNumber: state.pullRequestNumber || story.pullRequestNumber, headSha: state.headSha || story.headSha, updatedAt: state.updatedAt };
    });
  }
  private externalRuns(): RunSnapshot[] {
    return this.stories.filter((story) => story.agentStatus).map((story) => ({ schemaVersion: SCHEMA_VERSION, runId: `external-issue-${story.githubIssueNumber || story.storyId}`, storyId: story.storyId, status: story.executionStatus === "BLOCKED" ? "BLOCKED" : story.executionStatus === "FINISHED" ? "FINISHED" : "ACTIVE", phase: phaseForAgentStatus(story.agentStatus), startedAt: story.updatedAt, updatedAt: story.updatedAt, attempts: 1, maxStories: 1, autoMerge: false, validationStatus: story.validationStatus, effectiveConfigRevision: this.configRevision, interruptionReason: story.agentReason })) as RunSnapshot[];
  }
  private async ensureRuns(): Promise<void> {
    if (this.runsLoaded) return;
    this.runHistory = await this.persistence.listSnapshots();
    const interrupted = this.runHistory.filter((run) => ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(run.status));
    for (const run of interrupted) {
      const recovered = { ...run, status: "INTERRUPTED" as const, interruptionReason: "backend restarted before the run completed", updatedAt: new Date().toISOString() };
      await this.persistence.writeSnapshot(recovered.runId, recovered);
      this.runHistory = this.runHistory.map((item) => item.runId === recovered.runId ? recovered : item);
    }
    this.runsLoaded = true;
  }
}

function statusFor(story: StoryDetail): "pending" | "active" | "blocked" | "done" { if (story.deliveryStatus === "MERGED") return "done"; if (story.dependencyError || story.blockedReason) return "blocked"; if (["ACTIVE", "PAUSE_REQUESTED", "PAUSED", "STOP_REQUESTED"].includes(story.executionStatus)) return "active"; return "pending"; }
function phaseForAgentStatus(status?: string): RunSnapshot["phase"] { if (status === "FIXING") return "FIXING"; if (status === "REVIEWING") return "REVIEWING"; if (status === "PR_OPEN") return "CI"; if (status === "DONE") return "FINISHED"; if (status?.startsWith("PAUSED")) return "PAUSED"; return "IMPLEMENTING"; }
function issueUrl(config: AppConfigView, issue?: number): string | undefined { return issue ? `https://github.com/${config.owner}/${config.repo}/issues/${issue}` : undefined; }
function pullRequestUrl(config: AppConfigView, pullRequest?: number): string | undefined { return pullRequest ? `https://github.com/${config.owner}/${config.repo}/pull/${pullRequest}` : undefined; }
function unifiedDiff(before: string, after: string): string { const left = before.split(/\r?\n/); const right = after.split(/\r?\n/); const lines = [`--- current`, `+++ proposed`]; const size = Math.max(left.length, right.length); for (let index = 0; index < size; index += 1) { if (left[index] === right[index]) lines.push(`  ${left[index] || ""}`); else { if (left[index] !== undefined) lines.push(`- ${left[index]}`); if (right[index] !== undefined) lines.push(`+ ${right[index]}`); } } return lines.join("\n"); }
