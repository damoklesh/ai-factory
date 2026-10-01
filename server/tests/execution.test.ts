import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext, ExecutionHandle, ExecutionOutcome, ExecutionService } from "../src/execution.js";
import { ChildProcessExecutionService } from "../src/execution.js";
import { AgentPersistence } from "../src/persistence.js";
import { ProjectWorkspaceStore } from "../src/projects.js";
import { LocalController, type GithubSyncAdapter } from "../src/controller.js";
import { parseMarkdown } from "../src/stories.js";

const execFileAsync = promisify(execFile);
function story(id: string, priority: number, dependencies = "none", deliveryStatus = "NOT_STARTED", issue = priority): string { return `---\nstoryId: ${id}\ntitle: Story ${id}\npriority: ${priority}\ndependencies: ${dependencies}\ndeliveryStatus: ${deliveryStatus}\ngithubIssueNumber: ${issue}\nlabels: agent:ready\n---\n# ${id} — Story ${id}\n\n## User Story\nAs a user, I want ${id} so that it works.\n\n## Scope\n- In scope: ${id}\n\n## Acceptance Criteria\n- [ ] AC-1: ${id} works.\n\n## Validation\n- [ ] Run tests.\n`; }

class FakeExecution implements ExecutionService {
  contexts: ExecutionContext[] = [];
  private resolvers: Array<(outcome: ExecutionOutcome) => void> = [];
  constructor(private readonly failure?: Error) {}
  async start(context: ExecutionContext): Promise<ExecutionHandle> { if (this.failure) throw this.failure; this.contexts.push(context); const completion = new Promise<ExecutionOutcome>((resolve) => this.resolvers.push(resolve)); return { pid: 4321, completion, cancel: async () => this.finish(this.resolvers.length - 1, { status: "CANCELLED", summary: "cancelled by test", exitCode: null }) }; }
  finish(index: number, outcome: ExecutionOutcome): void { this.resolvers[index](outcome); }
}

async function fixture(execution: ExecutionService, githubAdapter?: GithubSyncAdapter): Promise<{ controller: LocalController; target: string; control: string; persistenceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-execution-")); const control = join(root, "control"); const target = join(root, "target"); const backlog = join(target, "backlog"); await mkdir(control); await mkdir(backlog, { recursive: true });
  await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  await writeFile(join(backlog, "US-001.md"), story("US-001", 1, "none", "MERGED", 1)); await writeFile(join(backlog, "US-002.md"), story("US-002", 2, "US-001", "NOT_STARTED", 2)); await writeFile(join(backlog, "US-003.md"), story("US-003", 1, "none", "NOT_STARTED", 3));
  const persistenceRoot = join(control, ".agent", "unselected"); const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const controller = new LocalController(new AgentPersistence(persistenceRoot), { projectStore: store, executionService: execution, githubAdapter }); await controller.selectProject(target); return { controller, target, control, persistenceRoot };
}

test("selects deterministically, spawns before ACTIVE, and completes visibly", async () => {
  const execution = new FakeExecution(); const { controller, target } = await fixture(execution); const run = await controller.start({ maxStories: 5, autoMerge: false, selectionMode: "auto" });
  assert.equal(run.status, "ACTIVE"); assert.equal(run.storyId, "US-003"); assert.equal(run.maxStories, 5); assert.equal(run.processId, 4321); assert.equal(execution.contexts[0].project.targetPath, await realpath(target)); assert.notEqual(execution.contexts[0].controlRoot, execution.contexts[0].project.targetPath); assert.equal(execution.contexts[0].story.storyId, "US-003");
  execution.contexts[0].onEvent?.({ source: "github", phase: "CI", level: "INFO", message: "waiting for checks", activity: "WAITING_FOR_CHECKS" });
  for (let attempt = 0; attempt < 20 && !(await controller.logs(run.runId)).entries.some((entry) => entry.message === "waiting for checks"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match((await controller.logs(run.runId)).entries.at(-1)?.message || "", /waiting for checks/); assert.equal((await controller.run(run.runId))?.activity, "WAITING_FOR_CHECKS");
  await assert.rejects(() => controller.start({ maxStories: 1, autoMerge: false }), /RUN_ALREADY_ACTIVE/);
  execution.finish(0, { status: "SUCCEEDED", summary: "PR #3 open", exitCode: 0 }); await new Promise((resolve) => setImmediate(resolve));
  const finished = (await controller.runs()).find((item) => item.runId === run.runId)!; assert.equal(finished.status, "SUCCEEDED"); assert.match(finished.resultSummary || "", /PR #3/);
});

test("honors explicit selection and dependency gates", async () => {
  const execution = new FakeExecution(); const { controller } = await fixture(execution); await assert.rejects(() => controller.start({ maxStories: 1, autoMerge: false, selectionMode: "selected", storyId: "US-001" }), /STORY_NOT_RUNNABLE/); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "selected", storyId: "US-002" }); assert.equal(run.storyId, "US-002");
  await assert.rejects(() => controller.start({ maxStories: 1, autoMerge: true }), /AUTO_MERGE_DISABLED/);
});

test("allows an explicitly selected story to restart after its PR was closed without merge", async () => {
  const execution = new FakeExecution();
  const githubAdapter: GithubSyncAdapter = { async observe() { return [{ storyId: "US-003", githubIssueNumber: 3, pullRequestNumber: 35, headSha: "closed-sha", state: "CLOSED", checks: "UNKNOWN", checkedAt: new Date().toISOString() }]; } };
  const { controller } = await fixture(execution, githubAdapter);
  await controller.sync();
  const restarted = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "selected", storyId: "US-003" });
  assert.equal(restarted.status, "ACTIVE");
  assert.equal(execution.contexts[0].story.storyId, "US-003");
  assert.equal(execution.contexts[0].story.pullRequestNumber, undefined);
  assert.equal(execution.contexts[0].freshStart, true);
  assert.equal((await controller.story("US-003"))?.blockedReason, undefined);
});

test("reconciles a missing GitHub issue link before execution after a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-restart-sync-")); const control = join(root, "control"); const target = join(root, "target"); const backlog = join(target, "backlog"); await mkdir(control); await mkdir(backlog, { recursive: true });
  await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  await writeFile(join(backlog, "US-001.md"), story("US-001", 1).replace("githubIssueNumber: 1\n", ""), "utf8");
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); await store.select(target);
  let observations = 0; const githubAdapter: GithubSyncAdapter = { async observe() { observations += 1; return [{ storyId: "US-001", githubIssueNumber: 18, state: "OPEN", checks: "UNKNOWN", checkedAt: new Date().toISOString() }]; } };
  const execution = new FakeExecution(); const controller = new LocalController(new AgentPersistence(join(control, ".agent", "unselected")), { projectStore: store, executionService: execution, githubAdapter }); await controller.selectProject(target);
  await controller.listStories();
  const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "selected", storyId: "US-001" });
  assert.equal(run.status, "ACTIVE"); assert.equal(observations, 1); assert.equal(execution.contexts[0].story.githubIssueNumber, 18);
});

test("materializes and resumes a blocked external orchestrator run after a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-external-resume-")); const control = join(root, "control"); const target = join(root, "target"); const backlog = join(target, "backlog"); await mkdir(control); await mkdir(backlog, { recursive: true });
  await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  await writeFile(join(backlog, "US-001.md"), story("US-001", 1, "none", "NOT_STARTED", 18), "utf8");
  const statePath = join(root, "automation", ".cache", "state.json"); await mkdir(join(root, "automation", ".cache"), { recursive: true }); await writeFile(statePath, JSON.stringify({ stories: { "18": { issueNumber: 18, branch: "agent/issue-18", status: "NEEDS_HUMAN", reason: "reviewer requested a decision", updatedAt: new Date().toISOString() } } }), "utf8");
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const execution = new FakeExecution(); const controller = new LocalController(new AgentPersistence(join(control, ".agent", "unselected")), { projectStore: store, executionService: execution, orchestratorStatePath: statePath }); await controller.selectProject(target);
  const external = (await controller.runs())[0]; assert.equal(external.runId, "external-issue-18"); assert.equal(external.status, "BLOCKED");
  const instruction = await controller.addInstruction(external.runId, { content: "Continue from the current PR", expectedRunStatus: "BLOCKED", idempotencyKey: "external-resume" }); assert.equal(instruction.status, "PENDING_NEXT_INVOCATION");
  const resumed = await controller.control(external.runId, "resume"); assert.equal(resumed.status, "ACTIVE"); assert.equal(resumed.storyId, "US-001"); assert.equal(execution.contexts[0].story.githubIssueNumber, 18); assert.deepEqual(execution.contexts[0].instructions, ["Continue from the current PR"]);
});

test("makes an interrupted PR stage resumable but keeps human merge pending outside the agent loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-pr-recovery-")); const control = join(root, "control"); const target = join(root, "target"); const backlog = join(target, "backlog"); await mkdir(control); await mkdir(backlog, { recursive: true });
  await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  await writeFile(join(backlog, "US-001.md"), story("US-001", 1, "none", "NOT_STARTED", 18), "utf8");
  const statePath = join(root, "automation", ".cache", "state.json"); await mkdir(join(root, "automation", ".cache"), { recursive: true });
  const writeState = async (status: string) => writeFile(statePath, JSON.stringify({ stories: { "18": { issueNumber: 18, branch: "agent/issue-18", status, pullRequestNumber: 35, updatedAt: new Date().toISOString() } } }), "utf8");
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const controller = new LocalController(new AgentPersistence(join(control, ".agent", "unselected")), { projectStore: store, executionService: new FakeExecution(), orchestratorStatePath: statePath }); await controller.selectProject(target);
  await writeState("PR_OPEN"); const resumable = (await controller.runs())[0]; assert.equal(resumable.status, "BLOCKED"); assert.notEqual(resumable.phase, "WAITING");
  await writeState("MERGE_PENDING_APPROVAL"); const awaitingMerge = (await controller.runs())[0]; assert.equal(awaitingMerge.status, "BLOCKED"); assert.equal(awaitingMerge.phase, "WAITING"); assert.equal(awaitingMerge.activity, "WAITING_FOR_INPUT");
});

test("exposes Resume when a cancelled local run left the external story in an active stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-stale-external-run-")); const control = join(root, "control"); const target = join(root, "target"); const backlog = join(target, "backlog"); await mkdir(control); await mkdir(backlog, { recursive: true });
  await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  await writeFile(join(backlog, "US-001.md"), story("US-001", 1, "none", "NOT_STARTED", 18), "utf8");
  const statePath = join(root, "automation", ".cache", "state.json"); await mkdir(join(root, "automation", ".cache"), { recursive: true });
  const stateUpdatedAt = new Date().toISOString(); await writeFile(statePath, JSON.stringify({ stories: { "18": { issueNumber: 18, branch: "agent/issue-18", status: "FIXING", processStatus: "RUNNING", reason: "validation failed", updatedAt: stateUpdatedAt } } }), "utf8");
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const execution = new FakeExecution(); const controller = new LocalController(new AgentPersistence(join(control, ".agent", "unselected")), { projectStore: store, executionService: execution, orchestratorStatePath: statePath }); await controller.selectProject(target);
  const started = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "selected", storyId: "US-001" }); execution.finish(0, { status: "CANCELLED", summary: "Orchestrator cancelled by user", exitCode: null });
  for (let attempt = 0; attempt < 20 && !(await controller.runs()).some((run) => run.runId === started.runId && run.status === "CANCELLED"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const external = (await controller.runs()).find((run) => run.runId === "external-issue-18"); assert.equal(external?.status, "BLOCKED"); assert.match(external?.interruptionReason || "", /cancelled/i);
});

test("continues an automatic plan once a fake GitHub adapter confirms the human merge", async () => {
  const execution = new FakeExecution(); let merged = false;
  const githubAdapter: GithubSyncAdapter = { async observe() { return [{ storyId: "US-003", githubIssueNumber: 3, pullRequestNumber: 30, headSha: "sha-30", state: merged ? "MERGED" : "OPEN", checks: "PASS", checkedAt: new Date().toISOString() }]; } };
  const { controller } = await fixture(execution, githubAdapter); const run = await controller.start({ maxStories: 2, autoMerge: false, selectionMode: "auto" });
  execution.finish(0, { status: "BLOCKED", summary: "MERGE_PENDING_APPROVAL: awaiting human merge approval" });
  for (let attempt = 0; attempt < 20 && (await controller.run(run.runId))?.status !== "BLOCKED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await controller.story("US-003"))?.deliveryStatus, "IMPLEMENTING");
  merged = true; await controller.sync();
  for (let attempt = 0; attempt < 20 && execution.contexts.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await controller.story("US-003"))?.deliveryStatus, "MERGED"); assert.equal(execution.contexts.length, 2); assert.equal(execution.contexts[1].story.storyId, "US-002");
});

test("persists a terminal failure when spawn or configuration fails", async () => {
  const { controller } = await fixture(new FakeExecution(new Error("fake spawn failure"))); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
  assert.equal(run.status, "FAILED"); assert.match(run.resultSummary || "", /fake spawn failure/); assert.equal((await controller.project()).activeRunId, undefined); assert.equal((await controller.runs())[0].status, "FAILED");
});

test("records distinct normal, non-zero, signal and cancellation outcomes", async () => {
  for (const outcome of [
    { status: "SUCCEEDED" as const, summary: "completed", exitCode: 0 },
    { status: "FAILED" as const, summary: "exited with 3", exitCode: 3 },
    { status: "FAILED" as const, summary: "terminated by SIGTERM", exitCode: null },
    { status: "CANCELLED" as const, summary: "cancelled by test", exitCode: null },
  ]) {
    const execution = new FakeExecution(); const { controller } = await fixture(execution); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
    execution.finish(0, outcome); await new Promise((resolve) => setImmediate(resolve));
    const saved = (await controller.runs()).find((item) => item.runId === run.runId)!;
    assert.equal(saved.status, outcome.status); assert.equal(saved.resultSummary, outcome.summary); assert.equal(saved.processId, 4321); assert.equal(saved.attempts, 1);
  }
});

test("stop requests cancellation and leaves a recoverable audit trail", async () => {
  const execution = new FakeExecution(); const { controller } = await fixture(execution); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
  const stopping = await controller.control(run.runId, "stop"); assert.ok(["STOP_REQUESTED", "CANCELLED"].includes(stopping.status));
  for (let attempt = 0; attempt < 20 && (await controller.runs())[0].status !== "CANCELLED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const saved = (await controller.runs()).find((item) => item.runId === run.runId)!; assert.equal(saved.status, "CANCELLED"); assert.match(saved.resultSummary || "", /cancelled/i); assert.equal(saved.processId, 4321);
});

test("restart reconciles a disappeared child process instead of showing it as running", async () => {
  const execution = new FakeExecution(); const { controller, target, control, persistenceRoot } = await fixture(execution); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const restarted = new LocalController(new AgentPersistence(persistenceRoot), { projectStore: store, executionService: new FakeExecution() }); await restarted.selectProject(target);
  const recovered = (await restarted.runs()).find((item) => item.runId === run.runId)!; assert.equal(recovered.status, "INTERRUPTED"); assert.equal(recovered.recoveryStatus, "INTERRUPTED"); assert.match(recovered.interruptionReason || "", /restarted/i); assert.equal(recovered.activity, "IDLE");
});

test("applies queued human instructions only to an explicit next invocation", async () => {
  const execution = new FakeExecution(); const { controller } = await fixture(execution); const run = await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
  execution.finish(0, { status: "BLOCKED", summary: "human clarification required" });
  for (let attempt = 0; attempt < 20 && (await controller.run(run.runId))?.status !== "BLOCKED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const instruction = await controller.addInstruction(run.runId, { content: "Inspect the edge case", expectedRunStatus: "BLOCKED", idempotencyKey: "next-only" }); assert.equal(instruction.status, "PENDING_NEXT_INVOCATION"); assert.equal(execution.contexts.length, 1);
  const resumed = await controller.control(run.runId, "resume"); assert.equal(resumed.attempts, 2); assert.deepEqual(execution.contexts[1].instructions, ["Inspect the edge case"]);
  assert.ok((await controller.logs(run.runId)).entries.some((entry) => /queued instruction.*applied/i.test(entry.message)));
});

test("rejects a second controller for the same target using the durable project lock", async () => {
  const firstExecution = new FakeExecution(); const { controller, target, control } = await fixture(firstExecution); await controller.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" });
  const secondExecution = new FakeExecution(); const secondStore = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const second = new LocalController(new AgentPersistence(join(control, ".agent", "unselected-2")), { projectStore: secondStore, executionService: secondExecution }); await second.selectProject(target); await assert.rejects(() => second.start({ maxStories: 1, autoMerge: false, selectionMode: "auto" }), /RUN_ALREADY_ACTIVE_FOR_PROJECT/);
});

test("spawns the trusted automation entrypoint with explicit target, story, run and manual-merge config", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-child-execution-")); const control = join(root, "control"); const target = join(root, "target"); const scriptDir = join(control, "automation", "dist", "src"); const stateRoot = join(control, ".agent", "project"); await mkdir(scriptDir, { recursive: true }); await mkdir(target);
  await writeFile(join(scriptDir, "orchestrator.js"), "console.log(JSON.stringify({aiFactoryEvent:true,source:'developer',phase:'IMPLEMENTING',level:'INFO',message:'fake developer running',activity:'RUNNING'})); setTimeout(() => console.log('fake orchestrator done'), 200);\n", "utf8"); await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/acme/target.git"], { windowsHide: true });
  const store = new ProjectWorkspaceStore(control, join(control, ".agent", "projects")); const project = await store.select(target); const output: string[] = []; const service = new ChildProcessExecutionService((_runId, _stream, chunk) => output.push(chunk)); const parsedStory = parseMarkdown("US-007.md", story("US-007", 1, "none", "NOT_STARTED", 7));
  let liveEvent!: (value: string) => void; const eventSeen = new Promise<string>((resolve) => { liveEvent = resolve; });
  const context: ExecutionContext = { runId: "run-007", story: parsedStory, project, controlRoot: await realpath(control), stateRoot, configRevision: "config-1", config: { owner: "acme", repo: "target", baseBranch: project.baseBranch || "master", modelVersion: "gpt-5.6", developerModel: "sol", developerReasoning: "medium", reviewerModel: "terra", reviewerReasoning: "high", validationCommands: ["npm test"], requiredChecks: [], maxStories: 1, maxFixCycles: 1, maxValidationAttempts: 3, autoMerge: false, stateFile: "state.json" }, onEvent: (event) => liveEvent(event.message) };
  const handle = await service.start(context); assert.ok(handle.pid); await assert.rejects(() => service.start({ ...context, runId: "duplicate" }), /RUN_ALREADY_ACTIVE_FOR_PROJECT/); assert.equal(await eventSeen, "fake developer running"); const outcome = await handle.completion; assert.equal(outcome.status, "SUCCEEDED"); assert.match(output.join(""), /developer running/);
  const runConfig = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(stateRoot, "run-run-007.config.json"), "utf8"))) as { targetWorkspace: string; autoMerge: boolean; selectedStoryId: string; runId: string; modelVersion: string; developerModel: string; developerReasoning: string; reviewerModel: string; reviewerReasoning: string; maxValidationAttempts: number };
  assert.equal(runConfig.targetWorkspace, project.targetPath); assert.equal(runConfig.autoMerge, false); assert.equal(runConfig.selectedStoryId, "US-007"); assert.equal(runConfig.runId, "run-007");
  assert.equal(runConfig.modelVersion, "gpt-5.6"); assert.equal(runConfig.developerModel, "sol"); assert.equal(runConfig.developerReasoning, "medium"); assert.equal(runConfig.reviewerModel, "terra"); assert.equal(runConfig.reviewerReasoning, "high"); assert.equal(runConfig.maxValidationAttempts, 3);
  const storyContract = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(stateRoot, "run-run-007.story.json"), "utf8"))) as { storyId: string; objective: string; dependencies: number[]; sourceDependencies: string[] }; assert.equal(storyContract.storyId, "US-007"); assert.match(storyContract.objective, /US-007/); assert.deepEqual(storyContract.dependencies, []); assert.deepEqual(storyContract.sourceDependencies, []);
  await writeFile(join(scriptDir, "orchestrator.js"), "console.log(process.argv.includes('--resume') ? 'resume flag present' : 'resume flag missing');\n", "utf8"); const resumedHandle = await service.start({ ...context, runId: "run-resume-flag", resume: true }); const resumedOutcome = await resumedHandle.completion; assert.equal(resumedOutcome.status, "SUCCEEDED"); assert.match(resumedOutcome.summary, /resume flag present/);
  await writeFile(join(scriptDir, "orchestrator.js"), "console.log(JSON.stringify({aiFactoryEvent:true,source:'orchestrator',phase:'WAITING',level:'WARN',message:'review publication failed',activity:'WAITING_FOR_INPUT',outcome:'REVIEW_FAILED'})); console.log('REVIEW_FAILED #7: publication failed'); console.error('(node:123) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, only concatenated.'); console.error('(Use `node --trace-deprecation ...` to show where the warning was created)');\n", "utf8");
  const reviewFailure = await service.start({ ...context, runId: "run-review-failed" }); const reviewFailureOutcome = await reviewFailure.completion; assert.equal(reviewFailureOutcome.status, "FAILED"); assert.match(reviewFailureOutcome.summary, /REVIEW_FAILED #7/); assert.doesNotMatch(reviewFailureOutcome.summary, /trace-deprecation/);
  await writeFile(join(scriptDir, "orchestrator.js"), "console.log(JSON.stringify({aiFactoryEvent:true,source:'orchestrator',phase:'WAITING',level:'WARN',message:'authentication required',activity:'WAITING_FOR_INPUT',outcome:'PAUSED_AUTH'}));\n", "utf8");
  const blocked = await service.start({ ...context, runId: "run-auth" }); assert.equal((await blocked.completion).status, "BLOCKED");
  await writeFile(join(scriptDir, "orchestrator.js"), "setTimeout(() => console.log('too late'), 5000);\n", "utf8");
  const timed = await new ChildProcessExecutionService(undefined, 50).start({ ...context, runId: "run-timeout" }); const timedOutcome = await timed.completion; assert.equal(timedOutcome.status, "FAILED"); assert.match(timedOutcome.summary, /timed out/);
  await writeFile(join(scriptDir, "orchestrator.js"), "setTimeout(() => console.log('never'), 5000);\n", "utf8"); const cancellable = await service.start({ ...context, runId: "run-cancel" }); await cancellable.cancel?.(); assert.equal((await cancellable.completion).status, "CANCELLED");
});
