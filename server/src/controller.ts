import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ApprovalRequest, AppConfigView, BacklogSyncPreview, BacklogSyncPublishResult, BacklogSyncRequest, BacklogValidation, ConfigUpdateRequest, DecisionRequest, DecisionResult, Diagnostic, GithubObservation, InstructionRequest, InstructionResult, LogEntry, LogPage, ProjectDoctorReport, ProjectSnapshot, ProjectStack, RecentProject, RunSnapshot, ScaffoldPlan, ScaffoldResult, SpecUpdateRequest, StartRunRequest, StoryDetail, StoryDiagnostic, StorySummary, SyncResult, TargetProject, WorkflowStage } from "@ai-factory/contracts";
import { SCHEMA_VERSION } from "@ai-factory/contracts";
import { AgentPersistence, sanitizeText } from "./persistence.js";
import { BACKLOG_STORY_TEMPLATE, loadBacklog } from "./stories.js";
import { loadAppConfig, configFilePath } from "./config.js";
import { ProjectWorkspaceStore } from "./projects.js";
import { desiredIssue, issueRevision, previewBacklogSync, type IssueMirror, type SyncBaseline } from "./backlog-sync.js";
import type { ExecutionHandle, ExecutionOutcome, ExecutionProcessEvent, ExecutionService } from "./execution.js";
import { applyScaffold, cancelScaffold, inspectProject, planScaffold } from "./doctor.js";
import { ProjectRunLock } from "./run-lock.js";

type Listener = (event: LogEntry) => void;
export interface GithubSyncAdapter { observe(stories: StoryDetail[]): Promise<GithubObservation[]>; listIssues?(): Promise<IssueMirror[]>; createIssue?(input: { title: string; body: string; labels: string[] }): Promise<IssueMirror>; updateIssue?(number: number, input: { title: string; body: string; labels: string[] }): Promise<IssueMirror>; }

interface OrchestratorStoryState { issueNumber: number; branch: string; status: string; fixCycles?: number; pullRequestNumber?: number; headSha?: string; reason?: string; updatedAt: string; startedAt?: string; processStatus?: string; reviewerStatus?: string; reviewerStartedAt?: string; reviewerFinishedAt?: string; attemptId?: string; }
interface OrchestratorState { stories?: Record<string, OrchestratorStoryState>; }
interface ControllerOptions { codexAvailable?: boolean; githubConnected?: boolean; githubObservations?: GithubObservation[]; githubAdapter?: GithubSyncAdapter; githubAdapterFactory?: (project: TargetProject) => GithubSyncAdapter | undefined; backlogRoot?: string; orchestratorStatePath?: string; approvals?: ApprovalRequest[]; configPath?: string; projectStore?: ProjectWorkspaceStore; executionService?: ExecutionService; }

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
  private activeProject?: TargetProject;
  private projectContextLoaded = false;
  private githubAdapter?: GithubSyncAdapter;
  private readonly syncPreviews = new Map<string, BacklogSyncPreview>();
  private startPending = false;
  private readonly executionHandles = new Map<string, ExecutionHandle>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly runLocks = new Map<string, ProjectRunLock>();
  private readonly configUpdates = new Map<string, { revision: string; config: AppConfigView; diff: string }>();
  private scaffoldPlan?: ScaffoldPlan;
  constructor(private persistence = new AgentPersistence(), private readonly options: ControllerOptions = {}) { this.config = loadAppConfig(options.configPath); this.githubAdapter = options.githubAdapter; this.githubConnected = options.githubConnected === true || Boolean(options.githubAdapter); this.approvalItems = options.approvals ? options.approvals.map((item) => ({ ...item })) : []; }

  async project(): Promise<ProjectSnapshot> {
    await this.ensureProjectContext();
    await this.ensureStories();
    await this.refreshOrchestratorState();
    await this.ensureRuns();
    const diagnostics: Diagnostic[] = [
      { name: "controller", available: true, message: "local controller ready" },
      { name: "target project", available: this.options.projectStore ? Boolean(this.activeProject) : true, message: this.activeProject ? `${this.activeProject.targetPath}${this.activeProject.dirty ? " (dirty)" : " (clean)"}` : this.options.projectStore ? "Select and confirm a target project" : "legacy fixed target" },
      { name: "backlog", available: !this.storyDiagnostics.some((item) => item.severity === "ERROR"), message: this.storyDiagnostics.length ? `${this.storyDiagnostics.filter((item) => item.severity === "ERROR").length} error(s), ${this.storyDiagnostics.filter((item) => item.severity === "WARNING").length} warning(s)` : "valid" },
      { name: "github", available: this.githubConnected, message: this.githubConnected ? "adapter connected" : "No GitHub adapter configured" },
      { name: "codex", available: this.options.codexAvailable !== false, message: this.options.codexAvailable === false ? "Codex executable is not available" : "available through the configured runner" },
    ];
    const githubConnected = this.githubConnected;
    const codexAvailable = this.options.codexAvailable !== false;
    const live = this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status) ? this.activeRun : undefined;
    const externalActive = this.stories.some((story) => ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(story.executionStatus));
    return { schemaVersion: SCHEMA_VERSION, repository: { owner: this.config.owner, repo: this.config.repo, baseBranch: this.config.baseBranch }, controller: { available: true, version: "ui-v1" }, github: { connected: githubConnected, checkedAt: this.lastSyncAt, stale: this.syncStale, message: githubConnected ? undefined : "No GitHub adapter configured" }, codex: { available: codexAvailable, message: codexAvailable ? undefined : "Codex executable is not available" }, activeRunId: live?.runId, counts: { total: this.stories.length, done: this.stories.filter((story) => story.deliveryStatus === "MERGED").length, blocked: this.stories.filter((story) => Boolean(story.blockedReason)).length, active: live ? 1 : externalActive ? 1 : 0 }, lastSyncAt: this.lastSyncAt, diagnostics, target: this.activeProject, recentProjects: this.options.projectStore ? await this.options.projectStore.recent() : undefined };
  }
  async selectProject(targetPath: string): Promise<TargetProject> { if (!this.options.projectStore) throw new Error("PROJECT_SELECTION_UNAVAILABLE"); this.assertProjectSwitchAllowed(); const project = await this.options.projectStore.select(targetPath); this.applyProject(project); return project; }
  async initializeProject(targetPath: string, confirmationPath: string): Promise<TargetProject> { if (!this.options.projectStore) throw new Error("PROJECT_SELECTION_UNAVAILABLE"); this.assertProjectSwitchAllowed(); const project = await this.options.projectStore.initialize(targetPath, confirmationPath); this.applyProject(project); return project; }
  async recentProjects(): Promise<RecentProject[]> { return this.options.projectStore ? this.options.projectStore.recent() : []; }
  async doctor(): Promise<ProjectDoctorReport> { await this.ensureProjectContext(); if (!this.activeProject) throw new Error("PROJECT_NOT_SELECTED"); return inspectProject(this.activeProject.targetPath); }
  async previewScaffold(stack: ProjectStack): Promise<ScaffoldPlan> { await this.ensureProjectContext(); if (!this.activeProject) throw new Error("PROJECT_NOT_SELECTED"); if (["mixed", "unknown"].includes(stack)) throw new Error("STACK_CONFIRMATION_REQUIRED"); this.scaffoldPlan = await planScaffold(this.activeProject.targetPath, stack as ScaffoldPlan["stack"]); return this.scaffoldPlan; }
  async createScaffold(stack: ProjectStack, confirm: boolean): Promise<ScaffoldResult> { await this.ensureProjectContext(); if (!this.activeProject?.gitRoot || !this.options.projectStore) throw new Error("TARGET_GIT_REQUIRED"); if (!this.scaffoldPlan || this.scaffoldPlan.stack !== stack) throw new Error("SCAFFOLD_PREVIEW_REQUIRED"); return applyScaffold(this.activeProject.gitRoot, this.options.projectStore.projectDataRoot(this.activeProject.projectId), this.scaffoldPlan, confirm); }
  async cancelScaffold(): Promise<{ cancelled: true }> { await this.ensureProjectContext(); if (!this.activeProject?.gitRoot || !this.options.projectStore) throw new Error("TARGET_GIT_REQUIRED"); await cancelScaffold(this.activeProject.gitRoot, this.options.projectStore.projectDataRoot(this.activeProject.projectId)); return { cancelled: true }; }
  async previewBacklogSync(): Promise<BacklogSyncPreview> { await this.ensureStories(); if (this.options.projectStore && !this.activeProject) throw new Error("PROJECT_NOT_SELECTED"); this.assertValidBacklog(); const adapter = this.publishAdapter(); const preview = previewBacklogSync(this.stories, await adapter.listIssues!(), await this.persistence.readMetadata<SyncBaseline>("backlog-sync.json", { stories: {} })); this.syncPreviews.set(preview.previewId, preview); while (this.syncPreviews.size > 10) this.syncPreviews.delete(this.syncPreviews.keys().next().value!); this.applySyncActions(preview); return preview; }
  async publishBacklog(request: BacklogSyncRequest): Promise<BacklogSyncPublishResult> {
    await this.ensureStories(); this.assertValidBacklog(); const original = this.syncPreviews.get(request.previewId); if (!original) throw new Error("SYNC_PREVIEW_NOT_FOUND"); const adapter = this.publishAdapter(); const baseline = await this.persistence.readMetadata<SyncBaseline>("backlog-sync.json", { stories: {} }); const issues = await adapter.listIssues!(); const fresh = previewBacklogSync(this.stories, issues, baseline); if (!samePreview(original, fresh)) throw new Error("SYNC_PREVIEW_STALE");
    const result: BacklogSyncPublishResult = { previewId: request.previewId, created: [], updated: [], unchanged: [], conflicts: [], failures: [] }; const resolutions = new Map(request.resolutions.map((item) => [item.storyId, item.decision]));
    for (const action of original.actions) {
      const story = this.stories.find((item) => item.storyId === action.storyId)!; const resolution = resolutions.get(action.storyId);
      if (action.kind === "CONFLICT" && resolution !== "USE_LOCAL") { result.conflicts.push(action); continue; }
      try {
        let issue: IssueMirror;
        const desired = desiredIssue(story, action.issueNumber);
        if (action.kind === "CREATE") { issue = await adapter.createIssue!({ title: desired.title, body: desired.body, labels: desired.labels }); result.created.push({ storyId: story.storyId, issueNumber: issue.number }); }
        else if (action.kind === "UNCHANGED") { issue = issues.find((item) => item.number === action.issueNumber)!; result.unchanged.push({ storyId: story.storyId, issueNumber: issue.number }); }
        else { issue = await adapter.updateIssue!(action.issueNumber!, { title: desired.title, body: desired.body, labels: desired.labels }); result.updated.push({ storyId: story.storyId, issueNumber: issue.number }); }
        baseline.stories[story.storyId] = { issueNumber: issue.number, localRevision: story.specRevision, remoteRevision: issueRevision(issue) };
        this.stories = this.stories.map((item) => item.storyId === story.storyId ? { ...item, githubIssueNumber: issue.number, syncStatus: "IN_SYNC" } : item);
      } catch (error) { result.failures.push({ storyId: story.storyId, message: sanitizeText(error instanceof Error ? error.message : String(error)) }); }
    }
    await this.persistence.writeMetadata("backlog-sync.json", baseline); this.syncPreviews.delete(request.previewId); return result;
  }
  async listStories(query?: { search?: string; status?: string }): Promise<StorySummary[]> {
    await this.ensureStories();
    await this.refreshOrchestratorState();
    const search = query?.search?.trim().toLowerCase();
    return this.stories.filter((story) => !search || `${story.storyId} ${story.title} ${story.objective}`.toLowerCase().includes(search)).filter((story) => !query?.status || query.status === "all" || statusFor(story) === query.status).map((story) => ({ storyId: story.storyId, title: story.title, priority: story.priority, dependencies: story.dependencies, deliveryStatus: story.deliveryStatus, executionStatus: story.executionStatus, validationStatus: story.validationStatus, specSource: story.specSource, specRevision: story.specRevision, githubIssueNumber: story.githubIssueNumber, pullRequestNumber: story.pullRequestNumber, headSha: story.headSha, validatedHeadSha: story.validatedHeadSha, externalStatus: story.externalStatus, externalStale: story.externalStale, blockedReason: story.blockedReason, dependencyError: story.dependencyError, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber), updatedAt: story.updatedAt, agentStatus: story.agentStatus, agentReason: story.agentReason, branch: story.branch, sourceFile: story.sourceFile, valid: story.valid, diagnostics: story.diagnostics, workflowStage: story.workflowStage, stageStartedAt: story.stageStartedAt, stageUpdatedAt: story.stageUpdatedAt, nextAction: story.nextAction, agentProcess: story.agentProcess }));
  }
  async backlogValidation(): Promise<BacklogValidation> { await this.ensureStories(); return { valid: !this.storyDiagnostics.some((item) => item.severity === "ERROR"), diagnostics: [...this.storyDiagnostics], template: BACKLOG_STORY_TEMPLATE }; }
  async story(storyId: string): Promise<StoryDetail | undefined> { await this.ensureStories(); await this.refreshOrchestratorState(); const story = this.stories.find((item) => item.storyId === storyId); return story ? { ...story, issueUrl: issueUrl(this.config, story.githubIssueNumber), pullRequestUrl: pullRequestUrl(this.config, story.pullRequestNumber) } : undefined; }
  async runs(): Promise<RunSnapshot[]> { await this.ensureRuns(); await this.ensureStories(); await this.refreshOrchestratorState(); return [...this.externalRuns(), ...this.runHistory]; }
  async run(runId: string): Promise<RunSnapshot | undefined> { await this.ensureRuns(); return this.runHistory.find((run) => run.runId === runId) || this.persistence.readSnapshot(runId); }
  async logs(runId: string, options: { cursor?: number; limit?: number; level?: LogEntry["level"]; source?: LogEntry["source"]; search?: string } = {}): Promise<LogPage> { return this.persistence.readEventsPage(runId, options); }
  async eventsSince(cursor = 0, runId?: string): Promise<LogEntry[]> { await this.ensureRuns(); const runs = runId ? this.runHistory.filter((run) => run.runId === runId) : this.runHistory; const events: LogEntry[] = []; for (const run of runs) events.push(...await this.persistence.readEvents(run.runId)); return events.filter((event) => event.sequence > cursor).sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence); }
  async approvals(): Promise<ApprovalRequest[]> { return this.approvalItems; }
  async decideApproval(requestId: string, request: DecisionRequest): Promise<DecisionResult> {
    const approval = this.approvalItems.find((item) => item.requestId === requestId);
    if (!approval) throw new Error("APPROVAL_NOT_FOUND");
    const previous = this.decisions.get(request.idempotencyKey); if (previous) return previous;
    const durable = (await this.persistence.readDecisions<{ idempotencyKey?: string; result?: DecisionResult }>(approval.runId)).find((item) => item.idempotencyKey === request.idempotencyKey)?.result; if (durable) { this.decisions.set(request.idempotencyKey, durable); return durable; }
    if (approval.status !== "PENDING") throw new Error("APPROVAL_ALREADY_DECIDED");
    if (request.decision === "REJECT" && !request.reason?.trim()) throw new Error("rejection reason required");
    if ((approval.expectedHeadSha && approval.expectedHeadSha !== request.expectedHeadSha) || (approval.expectedSpecRevision && approval.expectedSpecRevision !== request.expectedSpecRevision)) throw new Error("STALE_APPROVAL");
    if (approval.type === "MERGE" && request.decision === "APPROVE") {
      await this.ensureRuns(); await this.ensureStories(); const run = this.runHistory.find((item) => item.runId === approval.runId); const story = this.stories.find((item) => item.storyId === approval.storyId);
      if ((approval.expectedHeadSha && (run?.currentHeadSha || story?.headSha) && approval.expectedHeadSha !== (run?.currentHeadSha || story?.headSha)) || (approval.expectedSpecRevision && (run?.effectiveSpecRevision || story?.specRevision) && approval.expectedSpecRevision !== (run?.effectiveSpecRevision || story?.specRevision))) throw new Error("STALE_APPROVAL");
      if (approval.evidence.some((item) => /(ci|check|test).*(fail|pending)|(fail|pending).*(ci|check|test)/i.test(item))) throw new Error("MERGE_CHECKS_NOT_PASSING");
    }
    const now = new Date().toISOString();
    if (request.decision === "DEFER") { approval.status = "DEFERRED"; approval.decidedAt = now; approval.reason = request.reason; const result: DecisionResult = { accepted: true, requestId, status: "DEFERRED", message: "Decision deferred; the run remains blocked.", executionStatus: "PENDING" }; this.decisions.set(request.idempotencyKey, result); await this.persistence.appendDecision(approval.runId, { schemaVersion: 1, requestId, action: "DEFER", actor: "local-user", idempotencyKey: request.idempotencyKey, result, createdAt: now }); return result; }
    approval.status = request.decision === "APPROVE" ? "APPROVED" : "REJECTED"; approval.decidedAt = now; approval.reason = request.reason;
    const result: DecisionResult = { accepted: true, decisionId: randomUUID(), requestId, status: approval.status, message: request.decision === "APPROVE" ? (approval.type === "MERGE" ? "Approval recorded; GitHub checks and native review still apply." : "Approval recorded; the controller may continue at the next safe point.") : "Rejection recorded; the run remains blocked.", executionStatus: "PENDING" };
    this.decisions.set(request.idempotencyKey, result); await this.persistence.appendDecision(approval.runId, { schemaVersion: 1, decisionId: result.decisionId, requestId, decision: request.decision, actor: "local-user", reason: request.reason, expectedHeadSha: request.expectedHeadSha, expectedSpecRevision: request.expectedSpecRevision, idempotencyKey: request.idempotencyKey, result, createdAt: now, executionStatus: "PENDING" }); return result;
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
    await writeFile(path, request.markdown, "utf8"); const revision = createHash("sha256").update(request.markdown).digest("hex").slice(0, 12); this.stories = this.stories.map((item) => item.storyId === storyId ? { ...item, markdown: request.markdown, specRevision: revision, validationStatus: "STALE", validatedHeadSha: undefined, updatedAt: new Date().toISOString() } : item); return { preview: false, diff, revision };
  }
  async updateConfig(request: ConfigUpdateRequest): Promise<{ revision: string; config: AppConfigView; diff: string }> {
    const previous = this.configUpdates.get(request.idempotencyKey); if (previous) return previous;
    if (request.expectedRevision !== this.configRevision) throw new Error("VERSION_CONFLICT");
    const next = { ...this.config, ...request.config }; const diff = unifiedDiff(JSON.stringify(this.config, null, 2), JSON.stringify(next, null, 2));
    const path = configFilePath(this.options.configPath); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8"); await rename(temp, path);
    this.config = next; this.configRevision = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 12); const result = { revision: this.configRevision, config: { ...this.config }, diff }; this.configUpdates.set(request.idempotencyKey, result); return result;
  }
  async sync(): Promise<SyncResult> {
    await this.ensureProjectContext();
    if (this.options.projectStore && !this.activeProject) throw new Error("PROJECT_NOT_SELECTED");
    await this.ensureStories();
    this.assertValidBacklog();
    if (!this.githubAdapter && this.options.githubConnected !== true) { this.githubConnected = false; this.syncStale = true; return { connected: false, stale: true, message: "GitHub unavailable; remote facts were not changed", changedStoryIds: [] }; }
    let observations: GithubObservation[];
    try { observations = this.githubAdapter ? await this.githubAdapter.observe(this.stories) : this.options.githubObservations || []; this.githubConnected = true; } catch (error) { this.githubConnected = false; this.syncStale = true; this.stories = this.stories.map((story) => story.externalStatus ? { ...story, externalStale: true } : story); return { connected: false, stale: true, message: sanitizeText(error instanceof Error ? error.message : "GitHub unavailable; remote facts were not changed"), changedStoryIds: [] }; }
    const changedStoryIds: string[] = [];
    this.stories = this.stories.map((story) => {
      const observation = observations.find((item) => item.storyId === story.storyId); if (!observation) return story;
      const changed = observation.headSha !== story.headSha || observation.state !== story.externalStatus || observation.checks === "FAIL";
      if (changed) changedStoryIds.push(story.storyId);
      const pushed = Boolean(story.headSha && observation.headSha && story.headSha !== observation.headSha);
      const validationStatus = pushed ? "STALE" : observation.checks === "PASS" && observation.headSha && observation.validatedHeadSha === observation.headSha ? "PASS" : observation.checks === "FAIL" ? "FAIL" : observation.checks === "PENDING" ? "PENDING" : "UNKNOWN";
      return { ...story, githubIssueNumber: observation.githubIssueNumber || story.githubIssueNumber, pullRequestNumber: observation.pullRequestNumber || story.pullRequestNumber, headSha: observation.headSha || story.headSha, validatedHeadSha: observation.validatedHeadSha, externalStatus: observation.state, externalStale: false, validationStatus, deliveryStatus: observation.state === "MERGED" ? "MERGED" : story.deliveryStatus === "MERGED" ? "MERGED" : observation.pullRequestNumber ? "PR_OPEN" : story.deliveryStatus, blockedReason: observation.state === "CLOSED" ? "Pull request closed without merge" : story.blockedReason, updatedAt: observation.checkedAt };
    });
    await this.refreshOrchestratorState();
    await this.reconcileMergedStories(observations);
    this.lastSyncAt = new Date().toISOString(); this.syncStale = false; return { connected: true, stale: false, syncedAt: this.lastSyncAt, message: changedStoryIds.length ? `Reconciled ${changedStoryIds.length} story(ies)` : "Remote state is already current", changedStoryIds };
  }
  async history(): Promise<Array<{ runId: string; timestamp: string; message: string; phase: string }>> { await this.ensureRuns(); const entries: Array<{ runId: string; timestamp: string; message: string; phase: string }> = []; for (const run of this.runHistory) for (const event of await this.persistence.readEvents(run.runId)) entries.push({ runId: run.runId, timestamp: event.timestamp, message: event.message, phase: event.phase }); return entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp)); }
  async configView(): Promise<AppConfigView & { revision: string }> { return { ...this.config, revision: this.configRevision }; }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async start(request: StartRunRequest): Promise<RunSnapshot> {
    await this.ensureProjectContext();
    if (this.options.projectStore && !this.activeProject) throw new Error("PROJECT_NOT_SELECTED");
    await this.ensureStories();
    this.assertValidBacklog();
    await this.ensureRuns();
    if (request.autoMerge) throw new Error("AUTO_MERGE_DISABLED");
    if (request.expectedConfigRevision && request.expectedConfigRevision !== this.configRevision) throw new Error("VERSION_CONFLICT");
    if (this.startPending || (this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status))) throw new Error("RUN_ALREADY_ACTIVE");
    this.startPending = true; const now = new Date().toISOString(); const selectionMode = request.selectionMode || "auto"; let story: StoryDetail | undefined;
    try {
      story = this.selectRunnableStory(selectionMode, request.storyId);
      if (this.options.executionService && story) story = await this.ensureGithubIssueLink(story);
      if (this.options.executionService && !story) throw new Error("NO_ELIGIBLE_STORY");
      const maxStories = Math.max(1, Math.min(20, Math.floor(request.maxStories || 1))); const selectionPlan = this.plannedStoryIds(maxStories); this.activeRun = { schemaVersion: SCHEMA_VERSION, runId: randomUUID(), storyId: story?.storyId, status: "IDLE", phase: "SELECTING", startedAt: now, updatedAt: now, attempts: 0, maxStories, autoMerge: false, validationStatus: "PENDING", effectiveConfigRevision: this.configRevision, effectiveSpecRevision: story?.specRevision, selectionMode, targetProjectId: this.activeProject?.projectId, selectionPlan, completedStories: [], remainingStories: selectionPlan.slice(1) }; await this.persist("run accepted; starting bounded backlog plan");
    }
    catch (error) { this.startPending = false; throw error; }
    if (!this.options.executionService) { this.activeRun = { ...this.activeRun!, status: "ACTIVE", updatedAt: new Date().toISOString() }; if (story) this.markStoryActive(story, now); await this.persist("run started"); this.startPending = false; return this.activeRun; }
    try {
      const lock = new ProjectRunLock(this.options.projectStore!.projectDataRoot(this.activeProject!.projectId)); await lock.acquire(this.activeRun!.runId); this.runLocks.set(this.activeRun!.runId, lock); return await this.spawnExecution(story!);
    } catch (error) {
      if (error instanceof Error && ["RUN_ALREADY_ACTIVE_FOR_PROJECT", "RUN_LOCK_RECOVERY_REQUIRED"].includes(error.message)) { this.activeRun = undefined; throw error; }
      await this.runLocks.get(this.activeRun!.runId)?.release(this.activeRun!.runId); this.runLocks.delete(this.activeRun!.runId);
      this.activeRun = { ...this.activeRun, status: "FAILED", phase: "FINISHED", resultSummary: sanitizeText(error instanceof Error ? error.message : String(error)), updatedAt: new Date().toISOString() }; await this.persist("orchestrator failed to spawn"); const failed = this.activeRun; this.activeRun = undefined; return failed;
    } finally { this.startPending = false; }
  }
  async control(runId: string, action: "pause" | "stop" | "resume"): Promise<RunSnapshot> {
    await this.ensureProjectContext();
    await this.ensureStories();
    await this.refreshOrchestratorState();
    await this.ensureRuns();
    if (!this.activeRun) this.activeRun = this.runHistory.find((run) => run.runId === runId) || this.externalRuns().find((run) => run.runId === runId);
    if (!this.activeRun || this.activeRun.runId !== runId) throw new Error("RUN_NOT_FOUND");
    if (action === "pause" && this.activeRun.status === "ACTIVE") this.activeRun = { ...this.activeRun, status: "PAUSE_REQUESTED", pauseRequested: true, updatedAt: new Date().toISOString() };
    else if (action === "stop" && !["FINISHED", "STOPPED"].includes(this.activeRun.status)) this.activeRun = { ...this.activeRun, status: "STOP_REQUESTED", stopRequested: true, phase: "STOPPED", updatedAt: new Date().toISOString() };
    else if (action === "resume" && ["PAUSED", "STOPPED", "INTERRUPTED", "STOP_REQUESTED", "PAUSE_REQUESTED", "BLOCKED"].includes(this.activeRun.status)) {
      if (this.options.executionService && !this.executionHandles.has(runId)) {
        await this.ensureStories();
        let story = this.stories.find((item) => item.storyId === this.activeRun?.storyId); if (!story) throw new Error("STORY_NOT_FOUND");
        if (this.options.executionService) story = await this.ensureGithubIssueLink(story);
        const pending = (await this.persistence.readInstructions<{ instructionId: string; content?: string; status: string }>(runId)).filter((item) => item.status === "PENDING_NEXT_INVOCATION" && item.content);
        this.activeRun = { ...this.activeRun, status: "IDLE", phase: "SELECTING", activity: "IDLE", pauseRequested: false, stopRequested: false, updatedAt: new Date().toISOString() }; await this.persist("resume accepted; starting next invocation");
        const lock = new ProjectRunLock(this.options.projectStore!.projectDataRoot(this.activeProject!.projectId)); await lock.acquire(runId); this.runLocks.set(runId, lock); const resumed = await this.spawnExecution(story, pending.map((item) => item.content!), true);
        for (const item of pending) await this.persistence.appendInstruction(runId, { schemaVersion: 1, instructionId: item.instructionId, status: "APPLIED", appliedAt: new Date().toISOString(), invocation: resumed.attempts });
        if (pending.length) await this.persist(`${pending.length} queued instruction(s) applied to invocation ${resumed.attempts}`);
        return resumed;
      }
      this.activeRun = { ...this.activeRun, status: "ACTIVE", phase: "SELECTING", pauseRequested: false, stopRequested: false, updatedAt: new Date().toISOString() };
    }
    if (action === "stop") { const handle = this.executionHandles.get(runId); if (handle?.cancel) await handle.cancel(); }
    await this.persist(`run ${action} requested`);
    return this.activeRun;
  }
  private async persist(message: string): Promise<void> {
    if (!this.activeRun) return;
    const snapshot = { ...this.activeRun };
    this.runHistory = [snapshot, ...this.runHistory.filter((run) => run.runId !== snapshot.runId)];
    await this.enqueueEvent(snapshot.runId, snapshot, { source: "controller", phase: snapshot.phase, level: "INFO", message });
  }

  private async spawnExecution(story: StoryDetail, instructions: string[] = [], resume = false): Promise<RunSnapshot> {
    const project = this.activeProject!; const stateRoot = this.options.projectStore!.projectDataRoot(project.projectId); const runId = this.activeRun!.runId;
    const handle = await this.options.executionService!.start({ runId, story, project, controlRoot: this.options.projectStore!.controlRoot, stateRoot, configRevision: this.configRevision, config: { ...this.config }, instructions, resume, onEvent: (event) => { void this.recordProcessEvent(runId, event); } });
    this.executionHandles.set(runId, handle); this.activeRun = { ...this.activeRun!, status: "ACTIVE", phase: "IMPLEMENTING", activity: "RUNNING", processId: handle.pid, attempts: this.activeRun!.attempts + 1, updatedAt: new Date().toISOString() }; this.markStoryActive(story, this.activeRun.updatedAt); await this.persist("orchestrator process spawned"); void handle.completion.then((outcome) => this.completeExecution(runId, outcome)); return this.activeRun;
  }

  private async recordProcessEvent(runId: string, processEvent: ExecutionProcessEvent): Promise<void> {
    const current = this.runHistory.find((run) => run.runId === runId);
    if (!current || ["SUCCEEDED", "FAILED", "CANCELLED", "FINISHED", "INTERRUPTED"].includes(current.status)) return;
    const snapshot: RunSnapshot = { ...current, phase: processEvent.phase, activity: processEvent.activity || current.activity || "RUNNING", updatedAt: new Date().toISOString() };
    this.runHistory = [snapshot, ...this.runHistory.filter((run) => run.runId !== runId)];
    if (this.activeRun?.runId === runId) this.activeRun = snapshot;
    await this.enqueueEvent(runId, snapshot, processEvent);
  }

  private enqueueEvent(runId: string, snapshot: RunSnapshot, input: Pick<LogEntry, "source" | "phase" | "level" | "message" | "command">): Promise<void> {
    const previous = this.eventQueues.get(runId) || Promise.resolve();
    const next = previous.then(async () => {
      await this.persistence.writeSnapshot(runId, snapshot);
      const existing = await this.persistence.readEvents(runId);
      const sequence = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
      const event: LogEntry = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId, sequence, timestamp: new Date().toISOString(), ...input };
      await this.persistence.appendEvent(runId, event);
      for (const listener of this.listeners) listener(event);
    });
    this.eventQueues.set(runId, next.catch(() => undefined));
    return next;
  }

  private async ensureStories(): Promise<void> { await this.ensureProjectContext(); if (this.storiesLoaded) return; if (this.options.projectStore && !this.activeProject) { this.stories = []; this.storyDiagnostics = []; this.storiesLoaded = true; return; } const backlog = await loadBacklog(this.activeProject?.backlogPath || this.options.backlogRoot); this.stories = backlog.stories; this.storyDiagnostics = backlog.diagnostics; this.storiesLoaded = true; }
  private async ensureGithubIssueLink(story: StoryDetail): Promise<StoryDetail> {
    if (story.githubIssueNumber || (!this.githubAdapter && this.options.githubConnected !== true)) return story;
    await this.sync();
    const synced = this.stories.find((item) => item.storyId === story.storyId);
    if (!synced?.githubIssueNumber) return synced || story;
    const linked = { ...story, githubIssueNumber: synced.githubIssueNumber };
    this.stories = this.stories.map((item) => item.storyId === story.storyId ? linked : item);
    return linked;
  }
  private assertValidBacklog(): void { const first = this.storyDiagnostics.find((item) => item.severity === "ERROR"); if (first) throw new Error(`BACKLOG_INVALID: ${first.file}:${first.line} ${first.message}`); }
  private async ensureProjectContext(): Promise<void> { if (this.projectContextLoaded) return; this.projectContextLoaded = true; if (!this.options.projectStore) return; const project = await this.options.projectStore.active(); if (project) this.applyProject(project); }
  private applyProject(project: TargetProject): void { this.projectContextLoaded = true; this.activeProject = project; this.stories = []; this.storyDiagnostics = []; this.storiesLoaded = false; this.runHistory = []; this.runsLoaded = false; this.activeRun = undefined; this.persistence = new AgentPersistence(this.options.projectStore!.projectDataRoot(project.projectId)); this.githubAdapter = this.options.githubAdapterFactory ? this.options.githubAdapterFactory(project) : this.options.githubAdapter; this.githubConnected = this.options.githubConnected === true || Boolean(this.githubAdapter); if (project.github) this.config = { ...this.config, owner: project.github.owner, repo: project.github.repo, targetRepository: `${project.github.owner}/${project.github.repo}` }; if (project.baseBranch) this.config = { ...this.config, baseBranch: project.baseBranch, targetBranch: project.baseBranch }; }
  private assertProjectSwitchAllowed(): void { if (this.activeRun && ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(this.activeRun.status)) throw new Error("RUN_ALREADY_ACTIVE"); }
  private publishAdapter(): Required<Pick<GithubSyncAdapter, "listIssues" | "createIssue" | "updateIssue">> { const adapter = this.githubAdapter; if (!adapter?.listIssues || !adapter.createIssue || !adapter.updateIssue) throw new Error("GITHUB_PUBLISH_UNAVAILABLE"); return adapter as Required<Pick<GithubSyncAdapter, "listIssues" | "createIssue" | "updateIssue">>; }
  private applySyncActions(preview: BacklogSyncPreview): void { this.stories = this.stories.map((story) => { const action = preview.actions.find((item) => item.storyId === story.storyId); return action ? { ...story, githubIssueNumber: action.issueNumber || story.githubIssueNumber, syncStatus: action.kind === "CONFLICT" ? "CONFLICT" : action.kind === "UNCHANGED" ? "IN_SYNC" : "LOCAL_ONLY", conflict: action.kind === "CONFLICT" ? { repositoryRevision: action.localRevision, githubRevision: action.remoteRevision || "unknown", summary: action.reason || "Local and GitHub content diverged." } : undefined } : story; }); }
  private async reconcileMergedStories(observations: GithubObservation[]): Promise<void> {
    const mergedIds = observations.filter((item) => item.state === "MERGED").map((item) => item.storyId);
    if (!mergedIds.length) return;
    this.stories = this.stories.map((story) => mergedIds.includes(story.storyId) ? { ...story, deliveryStatus: "MERGED", executionStatus: "FINISHED", blockedReason: undefined, externalStatus: "MERGED", updatedAt: new Date().toISOString() } : story);
    const run = this.activeRun && ["BLOCKED", "INTERRUPTED"].includes(this.activeRun.status) && this.activeRun.selectionMode === "auto" ? this.activeRun : undefined;
    if (!run || !run.storyId || !mergedIds.includes(run.storyId) || run.attempts >= run.maxStories) return;
    const next = this.selectRunnableStory("auto");
    if (!next || !this.options.executionService || !this.activeProject || this.executionHandles.has(run.runId)) return;
    const completedStories = [...(run.completedStories || []), run.storyId];
    const remainingStories = (run.remainingStories || []).filter((item) => item !== next.storyId);
    this.activeRun = { ...run, storyId: next.storyId, status: "IDLE", phase: "SELECTING", activity: "IDLE", completedStories, remainingStories, resultSummary: undefined, updatedAt: new Date().toISOString() } as RunSnapshot;
    await this.persist(`confirmed external merge for ${run.storyId}; continuing with ${next.storyId}`);
    const lock = new ProjectRunLock(this.options.projectStore!.projectDataRoot(this.activeProject.projectId)); await lock.acquire(run.runId); this.runLocks.set(run.runId, lock); await this.spawnExecution(next);
  }
  private selectRunnableStory(mode: "selected" | "auto", storyId?: string): StoryDetail | undefined { const runnable = (story: StoryDetail) => story.valid !== false && story.deliveryStatus !== "MERGED" && story.executionStatus === "IDLE" && !story.blockedReason && !story.dependencyError && story.dependencies.every((dependency) => this.stories.find((item) => item.storyId === dependency)?.deliveryStatus === "MERGED"); if (mode === "selected") { const selected = this.stories.find((item) => item.storyId === storyId); if (!selected) throw new Error("STORY_NOT_FOUND"); if (!runnable(selected)) throw new Error(`STORY_NOT_RUNNABLE: ${selected.dependencyError || selected.blockedReason || "dependencies are not merged or the story is already active/completed"}`); return selected; } return [...this.stories].filter(runnable).sort((left, right) => left.priority - right.priority || left.storyId.localeCompare(right.storyId, "en") || (left.sourceFile || "").localeCompare(right.sourceFile || "", "en"))[0]; }
  private plannedStoryIds(maxStories: number): string[] { const candidates = this.stories.filter((story) => story.valid !== false && story.deliveryStatus !== "MERGED" && story.executionStatus === "IDLE" && !story.blockedReason && !story.dependencyError && story.dependencies.every((dependency) => this.stories.find((item) => item.storyId === dependency)?.deliveryStatus === "MERGED")).sort((left, right) => left.priority - right.priority || left.storyId.localeCompare(right.storyId, "en") || (left.sourceFile || "").localeCompare(right.sourceFile || "", "en")); return candidates.slice(0, maxStories).map((story) => story.storyId); }
  private markStoryActive(story: StoryDetail, updatedAt: string): void { this.stories = this.stories.map((item) => item.storyId === story.storyId ? { ...item, executionStatus: "ACTIVE", deliveryStatus: "IMPLEMENTING", branch: story.githubIssueNumber ? `agent/issue-${story.githubIssueNumber}` : item.branch, updatedAt } : item); }
  private async completeExecution(runId: string, outcome: ExecutionOutcome): Promise<void> { await this.eventQueues.get(runId); const run = this.runHistory.find((item) => item.runId === runId); if (!run) return; const awaitingMerge = /MERGE_PENDING_APPROVAL|awaiting human merge approval/i.test(outcome.summary); const terminalStatus = awaitingMerge ? "BLOCKED" as const : outcome.status; const finished = { ...run, status: terminalStatus, phase: "FINISHED" as const, activity: "IDLE" as const, resultSummary: sanitizeText(outcome.summary), updatedAt: new Date().toISOString() }; this.activeRun = finished; this.runHistory = [finished, ...this.runHistory.filter((item) => item.runId !== runId)]; this.executionHandles.delete(runId); await this.runLocks.get(runId)?.release(runId); this.runLocks.delete(runId); const story = run.storyId ? this.stories.find((item) => item.storyId === run.storyId) : undefined; if (awaitingMerge && story && !this.approvalItems.some((item) => item.runId === runId && item.type === "MERGE" && item.status === "PENDING")) this.approvalItems.push({ schemaVersion: SCHEMA_VERSION, requestId: randomUUID(), runId, storyId: story.storyId, type: "MERGE", status: "PENDING", problem: "The current PR passed automated review and checks.", evidence: [`PR #${story.pullRequestNumber || "unknown"}`, `HEAD SHA: ${story.headSha || "unknown"}`, "AI review: approved for this SHA", "Required checks: green for this SHA"], proposedAction: "Merge the current pull request after confirming the SHA and checks.", expectedHeadSha: story.headSha, expectedSpecRevision: story.specRevision, createdAt: finished.updatedAt });
    this.stories = this.stories.map((item) => item.storyId === run.storyId ? { ...item, executionStatus: terminalStatus === "BLOCKED" ? "BLOCKED" : "FINISHED", deliveryStatus: outcome.status === "SUCCEEDED" ? "PR_OPEN" : item.deliveryStatus, blockedReason: terminalStatus === "BLOCKED" || outcome.status === "FAILED" ? finished.resultSummary : item.blockedReason, updatedAt: finished.updatedAt } : item);
    if (outcome.status === "SUCCEEDED" && run.selectionMode === "auto" && run.attempts < run.maxStories) {
      await this.ensureStories();
      const next = this.selectRunnableStory("auto");
      if (next) { const completedStories = [...(run.completedStories || []), ...(run.storyId ? [run.storyId] : [])]; const remainingStories = (run.remainingStories || []).filter((item) => item !== next.storyId); this.activeRun = { ...finished, storyId: next.storyId, status: "IDLE", phase: "SELECTING", activity: "IDLE", completedStories, remainingStories, stopReason: undefined, updatedAt: new Date().toISOString() }; await this.persist(`confirmed merge; selecting next eligible story (${next.storyId})`); const lock = this.activeProject && this.options.projectStore ? new ProjectRunLock(this.options.projectStore.projectDataRoot(this.activeProject.projectId)) : undefined; if (lock) { await lock.acquire(runId); this.runLocks.set(runId, lock); } await this.spawnExecution(next); return; }
      this.activeRun = { ...finished, completedStories: [...(run.completedStories || []), ...(run.storyId ? [run.storyId] : [])], remainingStories: [], stopReason: "No further eligible stories", updatedAt: new Date().toISOString() };
    }
    await this.persist(`orchestrator ${terminalStatus.toLowerCase()}: ${finished.resultSummary}`); if (this.activeRun?.runId === runId && this.activeRun.status === terminalStatus && terminalStatus !== "BLOCKED") this.activeRun = undefined; }
  private async refreshOrchestratorState(): Promise<void> {
    let parsed: OrchestratorState | undefined;
    for (const statePath of this.orchestratorStatePaths()) {
      try { parsed = JSON.parse(await readFile(statePath, "utf8")) as OrchestratorState; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    }
    if (!parsed) return;
    const states = Object.values(parsed.stories || {});
    this.stories = this.stories.map((story) => {
      const state = states.find((item) => item.issueNumber === story.githubIssueNumber);
      if (!state) return story;
      const waiting = ["PR_OPEN", "READY_FOR_MERGE", "MERGE_PENDING_APPROVAL", "WAITING_FOR_CI"].includes(state.status);
      const active = ["IMPLEMENTING", "FIXING", "REVIEWING", "REVIEW_CHANGES_REQUESTED", "REVALIDATING"].includes(state.status);
      const blocked = ["FAILED_INFRA", "MERGE_FAILED", "NEEDS_HUMAN", "REVIEW_FAILED", "PAUSED_AUTH", "PAUSED_QUOTA"].includes(state.status);
      const stage = workflowStageFor(state.status);
      const stale = Date.now() - Date.parse(state.updatedAt) > 120_000;
      const processStatus = stale && (active || state.reviewerStatus === "RUNNING") ? "LOST" : state.processStatus === "RUNNING" ? "RUNNING" : state.processStatus === "STARTING" ? "STARTING" : blocked ? "FAILED" : state.reviewerStatus === "RUNNING" ? "RUNNING" : undefined;
      return { ...story, executionStatus: active ? "ACTIVE" : blocked ? "BLOCKED" : state.status === "DONE" ? "FINISHED" : waiting ? "PAUSED" : story.executionStatus, deliveryStatus: state.status === "PR_OPEN" || waiting ? "PR_OPEN" : state.status === "DONE" ? "MERGED" : active ? "IMPLEMENTING" : story.deliveryStatus, blockedReason: blocked ? state.reason || state.status : story.blockedReason, branch: state.branch, agentStatus: state.status, agentReason: state.reason, pullRequestNumber: state.pullRequestNumber || story.pullRequestNumber, headSha: state.headSha || story.headSha, workflowStage: stage, stageStartedAt: story.stageStartedAt || state.startedAt || state.updatedAt, stageUpdatedAt: state.updatedAt, nextAction: nextActionFor(state.status), agentProcess: processStatus ? { role: state.status === "REVIEWING" ? "REVIEWER" : state.status === "FIXING" ? "FIXER" : "IMPLEMENTER", status: processStatus as "STARTING" | "RUNNING" | "FAILED" | "LOST", startedAt: state.startedAt, lastEventAt: state.updatedAt } : undefined, updatedAt: state.updatedAt };
    });
  }
  private orchestratorStatePaths(): string[] {
    const paths: string[] = [];
    if (this.activeProject && this.options.projectStore) paths.push(join(this.options.projectStore.projectDataRoot(this.activeProject.projectId), "orchestrator-state.json"));
    if (this.options.orchestratorStatePath) paths.push(resolve(this.options.orchestratorStatePath));
    return [...new Set(paths)];
  }
  private externalRuns(): RunSnapshot[] {
    const persisted = new Set(this.runHistory.map((run) => run.runId));
    return this.stories.filter((story) => story.agentStatus).map((story) => {
      // The orchestrator state is durable, but a controller restart/cancel can
      // leave it at an active stage after the local run has already terminated.
      // Treat that combination as recoverable so the UI exposes Resume instead
      // of presenting a permanently active (and uncontrollable) run.
      const recoveredRun = this.runHistory.find((run) => run.storyId === story.storyId && ["CANCELLED", "FAILED", "INTERRUPTED"].includes(run.status) && Date.parse(run.updatedAt) >= Date.parse(story.updatedAt));
      const lostProcess = story.agentProcess?.status === "LOST";
      const blocked = story.executionStatus === "BLOCKED" || Boolean(recoveredRun) || lostProcess;
      const interruptionReason = recoveredRun?.resultSummary || story.agentReason || (lostProcess ? "The orchestrator process is no longer running; resume to continue." : undefined);
      return { schemaVersion: SCHEMA_VERSION, runId: `external-issue-${story.githubIssueNumber || story.storyId}`, storyId: story.storyId, status: blocked ? "BLOCKED" : story.executionStatus === "FINISHED" ? "FINISHED" : "ACTIVE", phase: phaseForAgentStatus(story.agentStatus), startedAt: story.updatedAt, updatedAt: story.updatedAt, attempts: 1, maxStories: 1, autoMerge: false, validationStatus: story.validationStatus, effectiveConfigRevision: this.configRevision, interruptionReason } as RunSnapshot;
    }).filter((run) => !persisted.has(run.runId));
  }
  private async ensureRuns(): Promise<void> {
    await this.ensureProjectContext();
    if (this.runsLoaded) return;
    this.runHistory = await this.persistence.listSnapshots();
    const lock = this.activeProject && this.options.projectStore ? new ProjectRunLock(this.options.projectStore.projectDataRoot(this.activeProject.projectId)) : undefined;
    const interrupted = this.runHistory.filter((run) => ["ACTIVE", "PAUSE_REQUESTED", "STOP_REQUESTED"].includes(run.status));
    for (const run of interrupted) {
      const owned = lock && await lock.isLive(run.runId);
      const childAlive = run.processId ? processAlive(run.processId) : false;
      if (owned && childAlive) { const verified = { ...run, recoveryStatus: "VERIFIED_RUNNING" as const, updatedAt: new Date().toISOString() }; this.runHistory = this.runHistory.map((item) => item.runId === run.runId ? verified : item); continue; }
      const recovered = { ...run, status: "INTERRUPTED" as const, recoveryStatus: childAlive ? "UNKNOWN" as const : "INTERRUPTED" as const, activity: "IDLE" as const, interruptionReason: childAlive ? "process identity could not be verified after backend restart" : "backend restarted before the run completed", updatedAt: new Date().toISOString() };
      await this.enqueueEvent(recovered.runId, recovered, { source: "controller", phase: recovered.phase, level: "WARN", message: recovered.interruptionReason });
      this.runHistory = this.runHistory.map((item) => item.runId === recovered.runId ? recovered : item);
    }
    this.runsLoaded = true;
  }
}

function statusFor(story: StoryDetail): "pending" | "active" | "blocked" | "done" { if (story.deliveryStatus === "MERGED") return "done"; if (story.dependencyError || story.blockedReason) return "blocked"; if (["ACTIVE", "PAUSE_REQUESTED", "PAUSED", "STOP_REQUESTED"].includes(story.executionStatus)) return "active"; return "pending"; }
function phaseForAgentStatus(status?: string): RunSnapshot["phase"] { if (status === "FIXING") return "FIXING"; if (status === "REVIEWING") return "REVIEWING"; if (status === "PR_OPEN") return "CI"; if (status === "DONE") return "FINISHED"; if (status?.startsWith("PAUSED")) return "PAUSED"; return "IMPLEMENTING"; }
function workflowStageFor(status: string): WorkflowStage | undefined {
  const map: Record<string, WorkflowStage> = { IMPLEMENTING: "IMPLEMENTING", PR_OPEN: "PR_OPEN", QUEUED_FOR_REVIEW: "PR_OPEN", REVIEWING: "REVIEWING", REVIEW_CHANGES_REQUESTED: "REVIEW_CHANGES_REQUESTED", FIXING: "FIXING_REVIEW", REVALIDATING: "REVALIDATING", VERIFYING: "WAITING_FOR_CI", READY_FOR_MERGE: "READY_FOR_MERGE", MERGE_PENDING_APPROVAL: "MERGE_PENDING_APPROVAL", DONE: "MERGED", NEEDS_HUMAN: "NEEDS_HUMAN", REVIEW_FAILED: "FAILED", MERGE_FAILED: "FAILED", FAILED_INFRA: "FAILED", PAUSED_AUTH: "NEEDS_HUMAN", PAUSED_QUOTA: "NEEDS_HUMAN" };
  return map[status];
}
function nextActionFor(status: string): string | undefined { if (["PR_OPEN", "QUEUED_FOR_REVIEW"].includes(status)) return "Waiting for reviewer"; if (status === "REVIEWING") return "Reviewer is inspecting the current SHA"; if (status === "REVIEW_CHANGES_REQUESTED" || status === "FIXING") return "Implementer must address current review findings"; if (status === "READY_FOR_MERGE") return "Reconcile current checks and review"; if (status === "MERGE_PENDING_APPROVAL") return "Human merge approval required"; if (["NEEDS_HUMAN", "FAILED", "MERGE_FAILED"].includes(status)) return "Review evidence and choose the next action"; return undefined; }
function issueUrl(config: AppConfigView, issue?: number): string | undefined { return issue ? `https://github.com/${config.owner}/${config.repo}/issues/${issue}` : undefined; }
function pullRequestUrl(config: AppConfigView, pullRequest?: number): string | undefined { return pullRequest ? `https://github.com/${config.owner}/${config.repo}/pull/${pullRequest}` : undefined; }
function samePreview(left: BacklogSyncPreview, right: BacklogSyncPreview): boolean { const comparable = (preview: BacklogSyncPreview) => preview.actions.map((item) => ({ storyId: item.storyId, kind: item.kind, issueNumber: item.issueNumber, localRevision: item.localRevision, remoteRevision: item.remoteRevision })); return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right)); }
function unifiedDiff(before: string, after: string): string { const left = before.split(/\r?\n/); const right = after.split(/\r?\n/); const lines = [`--- current`, `+++ proposed`]; const size = Math.max(left.length, right.length); for (let index = 0; index < size; index += 1) { if (left[index] === right[index]) lines.push(`  ${left[index] || ""}`); else { if (left[index] !== undefined) lines.push(`- ${left[index]}`); if (right[index] !== undefined) lines.push(`+ ${right[index]}`); } } return lines.join("\n"); }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
