import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { CodexRunError, CodexRunner } from "./codex.js";
import { buildPullRequestBody, replaceAgentLabel, RestGitHubClient, type GitHubClient } from "./github.js";
import { commitAndPush, createWorktree, gitDiff, gitRoot, removeWorktree, ensureTargetRepository, type Worktree } from "./git.js";
import { backlogPath, storyIssueId, syncBacklog } from "./backlog.js";
import { loadState, saveState, transition, canStartFix } from "./state.js";
import { evaluateMergeGate, mergeReviewedPullRequest } from "./merge.js";
import { parseStory, selectNextStory, storyEligibility, validateDependencyGraph } from "./stories.js";
import { runValidationPlan, validationsPassed, waitForRequiredChecks } from "./verify.js";
import type { Issue, OrchestrationConfig, PullRequest, StoryContract, StoryState } from "./types.js";

export interface CliOptions { configPath: string; dryRun: boolean; mock: boolean; syncBacklog: boolean; maxStories?: number; autoMerge?: boolean; storyId?: string; runId?: string; storyContractPath?: string; instructionPath?: string; }

function emitOperationalEvent(input: { source: "orchestrator" | "developer" | "reviewer" | "git" | "github" | "validation"; phase: string; message: string; level?: "INFO" | "WARN" | "ERROR"; command?: string; activity?: "RUNNING" | "WAITING_FOR_INPUT" | "WAITING_FOR_CHECKS"; outcome?: string }): void {
  console.log(JSON.stringify({ aiFactoryEvent: true, level: "INFO", activity: "RUNNING", ...input }));
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { configPath: process.env.AI_FACTORY_CONFIG || "config.json", dryRun: false, mock: false, syncBacklog: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mock") options.mock = true;
    else if (arg === "--sync-backlog") options.syncBacklog = true;
    else if (arg === "--config") options.configPath = args[++index] || options.configPath;
    else if (arg === "--max-stories") options.maxStories = Number(args[++index]);
    else if (arg === "--auto-merge") options.autoMerge = true;
    else if (arg === "--story-id") options.storyId = args[++index];
    else if (arg === "--run-id") options.runId = args[++index];
    else if (arg === "--story-contract") options.storyContractPath = args[++index];
    else if (arg === "--instruction-file") options.instructionPath = args[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.maxStories !== undefined && (!Number.isInteger(options.maxStories) || options.maxStories < 1)) throw new Error("--max-stories must be a positive integer");
  if (options.storyId !== undefined && !/^US-\d{3,}$/i.test(options.storyId)) throw new Error("--story-id must match US-###");
  return options;
}

function storyPrompt(issue: Issue, contract: StoryContract, feedback = "", instructions: string[] = [], attemptId = "implement-0"): string {
  return [`Implement GitHub Issue #${issue.number}: ${issue.title}`, `Attempt: ${attemptId}`, `Objective: ${contract.objective}`, "Acceptance criteria:", ...contract.acceptanceCriteria.map((item) => `- ${item}`), `Scope: ${contract.scope}`, `Validation: ${contract.validation.join("; ") || "use configured validation commands"}`, feedback ? `Feedback from the previous gate (only unresolved findings for the prior SHA):\n${feedback}` : "", instructions.length ? `Additional human instructions for this invocation:\n${instructions.map((item) => `- ${item}`).join("\n")}` : "", "Work only in the current worktree. Do not change controller policy, CI protections, or credentials. Do not declare review clean or merge. End with the required JSON result."].filter(Boolean).join("\n");
}

function reviewPrompt(issue: Issue, contract: StoryContract, diff: string, validationOutput: string, snapshot: { storyId: string; runId: string; pullRequest: number; sha: string }): string {
  return [`Review Issue #${issue.number}: ${issue.title}`, `Review snapshot: storyId=${snapshot.storyId}; runId=${snapshot.runId}; pullRequest=${snapshot.pullRequest}; sha=${snapshot.sha}`, `Objective: ${contract.objective}`, "Acceptance criteria:", ...contract.acceptanceCriteria.map((item) => `- ${item}`), `Diff:\n${diff}`, `Validation evidence:\n${validationOutput}`, "Return only the review JSON. Do not modify files, push, merge, alter policy, or handle secrets.", "Every actionable finding should include file:line when available in its text."].join("\n");
}

function reviewPublicationBody(result: { findings: string[]; evidence: string[]; decision: string }, snapshot: { storyId: string; runId: string; sha: string }): string {
  return [`AI Factory review`, `Story: ${snapshot.storyId}`, `Run: ${snapshot.runId}`, `Reviewed SHA: ${snapshot.sha}`, `Decision: ${result.decision}`, "", "Findings:", ...(result.findings.length ? result.findings.map((item) => `- ${item}`) : ["- No actionable findings."]), "", "Evidence:", ...(result.evidence.length ? result.evidence.map((item) => `- ${item}`) : ["- Reviewer completed without additional evidence."])].join("\n");
}

function formatFailure(state: StoryState, reason: string): string {
  return JSON.stringify({ issue: state.issueNumber, pr: state.pullRequestNumber || null, branch: state.branch, sha: state.headSha || null, cycle: state.fixCycles, reason });
}

async function mark(client: GitHubClient, issue: Issue, status: "agent:running" | "agent:blocked" | "agent:done"): Promise<void> {
  await client.setIssueLabels(issue.number, replaceAgentLabel(issue.labels, status));
}

async function processStory(client: GitHubClient, config: OrchestrationConfig, target: { path: string; controlRoot: string; env?: NodeJS.ProcessEnv }, issue: Issue, contract: StoryContract, stateFile: string, instructions: string[] = []): Promise<StoryStatusResult> {
  emitOperationalEvent({ source: "git", phase: "IMPLEMENTING", message: `Preparing isolated worktree for issue #${issue.number}` });
  const state = await loadState(stateFile);
  const branch = `agent/issue-${issue.number}`;
  const root = target.path;
  let worktree: Worktree | undefined;
  let pullRequest: PullRequest | undefined = (await client.listPullRequests(branch))[0];
  let feedback = "";
  const previous = state.stories[String(issue.number)];
  const firstCycle = previous?.fixCycles || 0;
  transition(state, issue.number, "IMPLEMENTING", { branch, pullRequestNumber: pullRequest?.number, startedAt: new Date().toISOString(), processStatus: "STARTING", sourceIssueUrl: `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}` });
  await saveState(stateFile, state);
  await mark(client, issue, "agent:running");
  try {
    worktree = await createWorktree(root, config.targetBranch, branch, { env: target.env });
    const codex = new CodexRunner(target.controlRoot, config.model);
    for (let cycle = firstCycle; cycle <= config.maxFixCycles; cycle += 1) {
      const attemptId = `${config.runId || "cli"}:${issue.number}:${cycle === 0 ? "implement" : "fix"}-${cycle}`;
      transition(state, issue.number, cycle === 0 ? "IMPLEMENTING" : "FIXING", { branch, fixCycles: cycle, pullRequestNumber: pullRequest?.number, reason: feedback || undefined, attemptId, fixerStatus: cycle === 0 ? undefined : "STARTING" });
      await saveState(stateFile, state);
      try {
        emitOperationalEvent({ source: "developer", phase: cycle === 0 ? "IMPLEMENTING" : "FIXING", message: `Developer agent started for issue #${issue.number}, cycle ${cycle}${instructions.length ? ` with ${instructions.length} human instruction(s)` : ""}` });
        transition(state, issue.number, cycle === 0 ? "IMPLEMENTING" : "FIXING", { processStatus: "RUNNING", fixerStatus: cycle === 0 ? undefined : "RUNNING", reason: feedback || undefined });
        await saveState(stateFile, state);
        await codex.developer(storyPrompt(issue, contract, feedback, instructions, attemptId), worktree.path, config.timeouts.codexMinutes * 60_000);
        transition(state, issue.number, cycle === 0 ? "IMPLEMENTING" : "FIXING", { processStatus: "SUCCEEDED", fixerStatus: cycle === 0 ? undefined : "SUCCEEDED", findingDispositions: cycle === 0 ? undefined : Object.fromEntries((state.stories[String(issue.number)].reviewFindings || []).map((finding) => [finding, "FIXED" as const])) });
      } catch (error) {
        const kind = error instanceof CodexRunError ? error.kind : "FAILED";
        const status = kind === "AUTH" ? "PAUSED_AUTH" : kind === "QUOTA" ? "PAUSED_QUOTA" : "FAILED_INFRA";
        transition(state, issue.number, status, { processStatus: kind === "AUTH" || kind === "QUOTA" ? "BLOCKED" : "FAILED", fixerStatus: cycle === 0 ? undefined : "FAILED", reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state);
        await mark(client, issue, "agent:blocked");
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], state.stories[String(issue.number)].reason || "Codex failed"));
        return { status, state: state.stories[String(issue.number)] };
      }
      emitOperationalEvent({ source: "validation", phase: "TESTING", message: `Running ${config.validationCommands.length} validation and ${config.smokeCommands.length} smoke command(s)`, command: [...config.validationCommands, ...config.smokeCommands].join(" && ") });
      const plan = await runValidationPlan(config.validationCommands, config.smokeCommands, worktree.path, config.timeouts.workflowMinutes * 60_000); const validation = [...plan.validation, ...plan.smoke];
      const validationText = validation.map((item) => `${item.passed ? "PASS" : "FAIL"} ${item.command}\n${item.output}`).join("\n");
      const validationEvidence = validation.map((item) => ({ command: item.command, passed: item.passed, output: item.output.slice(0, 4_000) }));
      if (!validationsPassed(validation)) {
        feedback = `Local validation failed:\n${validationText}`;
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback, reviewHeadSha: undefined, reviewSha: undefined, reviewerStatus: undefined });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        continue;
      }
      emitOperationalEvent({ source: "git", phase: "IMPLEMENTING", message: `Creating reviewed commit on ${branch}` });
      const commit = await commitAndPush(worktree.path, branch, `feat: implement US #${issue.number}`, { env: target.env, allowedPaths: config.allowedChangePaths });
      const body = buildPullRequestBody(issue.number, branch, { storyId: `US-${String(issue.number).padStart(3, "0")}`, objective: contract.objective, acceptanceCriteria: contract.acceptanceCriteria, validation: validationEvidence, sourceIssueUrl: `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}` });
      if (!pullRequest) pullRequest = await client.createPullRequest({ title: issue.title, body, headBranch: branch, baseBranch: config.baseBranch });
      else if (client.updatePullRequest) pullRequest = await client.updatePullRequest(pullRequest.number, { title: issue.title, body });
      transition(state, issue.number, "PR_OPEN", { pullRequestNumber: pullRequest.number, headSha: commit.sha, branch, fixCycles: cycle, validation: validationEvidence, changedFiles: commit.files, pullRequestUrl: `https://github.com/${config.owner}/${config.repo}/pull/${pullRequest.number}`, processStatus: "SUCCEEDED" });
      await saveState(stateFile, state);
      emitOperationalEvent({ source: "github", phase: "CI", message: `Waiting for required checks on ${commit.sha.slice(0, 12)}`, activity: "WAITING_FOR_CHECKS" });
      const checks = await waitForRequiredChecks(client, commit.sha, config.requiredChecks, config.timeouts.ciMinutes * 60_000);
      if (checks.decision === "FAIL") {
        feedback = config.requiredChecks.length ? `Required CI checks failed or timed out for SHA ${commit.sha}.` : "No required checks configured; configure at least one required check before merge.";
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback, reviewHeadSha: undefined, reviewSha: undefined, reviewerStatus: undefined });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], feedback));
        continue;
      }
      transition(state, issue.number, "REVIEWING", { headSha: commit.sha });
      await saveState(stateFile, state);
      emitOperationalEvent({ source: "reviewer", phase: "REVIEWING", message: `Reviewer agent started for issue #${issue.number}` });
      const diff = await gitDiff(worktree.path, config.baseBranch);
      const runId = config.runId || "cli";
      const snapshot = { storyId: `US-${String(issue.number).padStart(3, "0")}`, runId, pullRequest: pullRequest.number, sha: commit.sha };
      const publicationKey = `${runId}:${issue.number}:${cycle}:${commit.sha}`;
      transition(state, issue.number, "REVIEWING", { reviewerStatus: "RUNNING", reviewerStartedAt: new Date().toISOString(), reviewSha: commit.sha, reviewPublicationKey: publicationKey });
      await saveState(stateFile, state);
      let review;
      try {
        review = await codex.reviewer(reviewPrompt(issue, contract, diff, validationText, snapshot), worktree.path, config.timeouts.codexMinutes * 60_000);
      } catch (error) {
        transition(state, issue.number, "REVIEW_FAILED", { reviewerStatus: "FAILED", reviewerFinishedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], state.stories[String(issue.number)].reason || "Reviewer failed"));
        return { status: "REVIEW_FAILED", state: state.stories[String(issue.number)] };
      }
      const publication = reviewPublicationBody(review, snapshot);
      let reviewUrl = state.stories[String(issue.number)].reviewUrl;
      try {
        if (state.stories[String(issue.number)].reviewPublicationKey !== publicationKey || !reviewUrl) {
          const published = await client.publishPullRequestReview?.(pullRequest.number, { body: publication, changesRequested: review.decision === "CHANGES_REQUESTED", idempotencyKey: publicationKey });
          reviewUrl = published?.url || `${config.owner}/${config.repo}/pull/${pullRequest.number}#ai-factory-review-${publicationKey}`;
        }
      } catch (error) {
        transition(state, issue.number, "REVIEW_FAILED", { reviewerStatus: "FAILED", reviewerFinishedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "REVIEW_FAILED", state: state.stories[String(issue.number)] };
      }
      transition(state, issue.number, "REVIEWING", { reviewHeadSha: commit.sha, reviewerStatus: "SUCCEEDED", reviewerFinishedAt: new Date().toISOString(), reviewFindings: review.findings, reviewEvidence: review.evidence, reviewUrl });
      await saveState(stateFile, state);
      if (review.decision === "NEEDS_HUMAN") {
        transition(state, issue.number, "NEEDS_HUMAN", { reason: review.findings.join("; ") || "Reviewer requested human decision" });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
      }
      if (review.decision === "CHANGES_REQUESTED") {
        feedback = review.findings.join("; ") || "Reviewer requested changes";
        transition(state, issue.number, "REVIEW_CHANGES_REQUESTED", { reason: feedback });
        await saveState(stateFile, state);
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback, reviewHeadSha: undefined, reviewSha: undefined, reviewerStatus: undefined });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], feedback));
        continue;
      }
      transition(state, issue.number, "REVIEW_APPROVED", { reviewHeadSha: commit.sha });
      await saveState(stateFile, state);
      let gate;
      try {
        const current = await client.getPullRequest(pullRequest.number);
        const reviewThreads = client.getReviewThreads
          ? await client.getReviewThreads(pullRequest.number, current.headSha)
          : { available: false, threads: [], reason: "review thread provider unavailable" };
        gate = evaluateMergeGate({ currentSha: current.headSha, reviewedSha: commit.sha, reviewDecision: review.decision, checks: checks.checks, requiredChecks: config.requiredChecks, reviewThreads });
      } catch (error) {
        transition(state, issue.number, "MERGE_FAILED", { reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "MERGE_FAILED", state: state.stories[String(issue.number)] };
      }
      if (!gate.ready) {
        transition(state, issue.number, "READY_FOR_MERGE", { reason: gate.reason, headSha: commit.sha });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "READY_FOR_MERGE", state: state.stories[String(issue.number)] };
      }
      if (!config.autoMerge) {
        transition(state, issue.number, "MERGE_PENDING_APPROVAL", { headSha: commit.sha, reviewHeadSha: commit.sha, reason: "Awaiting human merge approval" });
        await saveState(stateFile, state);
        emitOperationalEvent({ source: "github", phase: "WAITING", message: `Awaiting human merge approval for PR #${pullRequest.number}`, activity: "WAITING_FOR_INPUT", outcome: "MERGE_PENDING_APPROVAL" });
        return { status: "MERGE_PENDING_APPROVAL", state: state.stories[String(issue.number)] };
      }
      let merged;
      try {
        merged = await mergeReviewedPullRequest(client, pullRequest.number, commit.sha);
      } catch (error) {
        transition(state, issue.number, "MERGE_FAILED", { reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "MERGE_FAILED", state: state.stories[String(issue.number)] };
      }
      if (!merged.merged) {
        transition(state, issue.number, "MERGE_FAILED", { reason: merged.message }); await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "MERGE_FAILED", state: state.stories[String(issue.number)] };
      }
      transition(state, issue.number, "DONE", { headSha: commit.sha, reviewHeadSha: commit.sha });
      await saveState(stateFile, state); await client.closeIssue(issue.number); await mark(client, issue, "agent:done");
      return { status: "DONE", state: state.stories[String(issue.number)] };
    }
    transition(state, issue.number, "NEEDS_HUMAN", { reason: `maximum fix cycles (${config.maxFixCycles}) exhausted; attempts=${state.stories[String(issue.number)].fixCycles}; pullRequest=${state.stories[String(issue.number)].pullRequestNumber || "none"}; lastSha=${state.stories[String(issue.number)].headSha || "unknown"}; findings=${(state.stories[String(issue.number)].reviewFindings || []).join(" | ") || "none"}` });
    await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
    return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
  } finally {
    if (worktree) await removeWorktree(root, worktree);
  }
}

interface StoryStatusResult { status: StoryState["status"]; state: StoryState; }

function mockIssue(number: number, priority: number, dependency = "None"): Issue { return { number, title: `Mock US ${number}`, state: "open", labels: ["agent:ready"], body: `## Objective\nAs a user I want mock story ${number}.\n## Acceptance criteria\n- The story completes\n## Scope\nMock controller\n## Dependencies\n${dependency}\n## Priority\n${priority}\n## Validation\nnpm test` }; }

async function runMock(maxStories: number): Promise<number> {
  const issues = [mockIssue(1, 1), mockIssue(2, 2, "#1")];
  const completed = new Set<number>();
  for (let count = 0; count < maxStories; count += 1) {
    const selected = selectNextStory(issues, completed);
    if (!selected) break;
    parseStory(selected.issue);
    completed.add(selected.issue.number);
    console.log(`MOCK MERGED #${selected.issue.number} (${selected.contract.objective})`);
  }
  console.log(`Mock sprint completed ${completed.size} story/stories; no GitHub, Codex, worktree, push, or merge operation was performed.`);
  return completed.size === maxStories ? 0 : 1;
}

export async function runOrchestrator(args: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (options.mock) return runMock(options.maxStories || 1);
  if (options.dryRun) {
    console.log("AI Factory dry-run: no GitHub, worktree, Codex, push, or merge operation will be performed.");
    if (!existsSync(options.configPath)) { console.log(`Config not found at ${options.configPath}; copy config.example.json for a configured run.`); return 0; }
    const config = loadConfig(options.configPath);
    console.log(`Control repository: ${config.controlRepository || "current checkout"}`);
    console.log(`Target repository: ${config.targetRepository}`);
    console.log(`Target branch: ${config.targetBranch}; max stories: ${options.maxStories ?? config.maxStories}; autoMerge: ${options.autoMerge ?? config.autoMerge}; story: ${options.storyId || "auto"}; run: ${options.runId || "cli"}`);
    console.log(`Validation commands: ${config.validationCommands.length}; required checks: ${config.requiredChecks.length}`);
    if (options.syncBacklog) console.log(`Backlog sync: ${config.targetBacklogPath}`);
    return 0;
  }
  const config = loadConfig(options.configPath);
  const token = (process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("AGENT_GH_TOKEN or GITHUB_TOKEN is required for a configured run; use --dry-run or --mock without credentials.");
  const effectiveConfig = { ...config, maxStories: options.maxStories ?? config.maxStories, autoMerge: options.autoMerge ?? config.autoMerge };
  const client = new RestGitHubClient(config.owner, config.repo, token);
  const controlRoot = await gitRoot(process.cwd());
  const target = await ensureTargetRepository(config, controlRoot, token);
  if (options.syncBacklog) {
    const result = await syncBacklog(client, backlogPath(target.path, config.targetBacklogPath));
    console.log(`Backlog sync completed: ${result.created.length} created, ${result.updated.length} updated, ${result.existing.length} already linked.`);
    return 0;
  }
  const stateFile = resolve(config.stateFile);
  const state = await loadState(stateFile);
  const issues = await client.listIssues();
  const completed = new Set(issues.filter((issue) => issue.labels.includes("agent:done")).map((issue) => issue.number));
  const explicitContract = options.storyContractPath ? loadExplicitContract(options.storyContractPath) : undefined;
  const instructions = options.instructionPath ? loadInstructions(options.instructionPath) : [];
  for (let count = 0; count < effectiveConfig.maxStories; count += 1) {
    const selection = options.storyId ? selectExplicitStory(issues, completed, options.storyId, explicitContract) : selectNextStory(issues, completed);
    if (!selection) { console.log("No eligible agent:ready story found."); break; }
    const result = await processStory(client, effectiveConfig, { ...target, controlRoot }, selection.issue, selection.contract, stateFile, instructions);
    emitOperationalEvent({ source: "orchestrator", phase: result.status === "PR_OPEN" || result.status === "DONE" ? "FINISHED" : "WAITING", message: `${result.status} #${selection.issue.number}${result.state.reason ? `: ${result.state.reason}` : ""}`, level: result.status === "FAILED_INFRA" ? "ERROR" : result.status === "PR_OPEN" || result.status === "DONE" ? "INFO" : "WARN", activity: result.status === "PR_OPEN" || result.status === "DONE" ? "RUNNING" : "WAITING_FOR_INPUT", outcome: result.status });
    console.log(`${result.status} #${selection.issue.number}${result.state.reason ? `: ${result.state.reason}` : ""}`);
    if (result.status === "DONE") completed.add(selection.issue.number); else break;
  }
  return 0;
}

export function selectExplicitStory(issues: Issue[], completed: Set<number>, storyId: string, suppliedContract?: StoryContract): { issue: Issue; contract: StoryContract } {
  const issue = issues.find((item) => storyIssueId(item)?.toUpperCase() === storyId.toUpperCase());
  if (!suppliedContract && validateDependencyGraph(issues).length > 0) throw new Error(`story selection refused: ${validateDependencyGraph(issues).join("; ")}`);
  const reason = storyEligibility(issue, issues, completed);
  if (reason) throw new Error(`story selection refused: ${reason}`);
  const contract = suppliedContract || parseStory(issue!);
  const unmet = contract.dependencies.find((dependency) => !completed.has(dependency));
  if (unmet) throw new Error(`story selection refused: story #${issue!.number} has unmet dependency #${unmet}`);
  return { issue: issue!, contract };
}

function loadExplicitContract(path: string): StoryContract {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<StoryContract>;
  if (typeof value.objective !== "string" || !value.objective || !Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.some((item) => typeof item !== "string") || typeof value.scope !== "string" || !Array.isArray(value.dependencies) || value.dependencies.some((item) => !Number.isInteger(item)) || !Number.isInteger(value.priority) || Number(value.priority) < 1 || !Array.isArray(value.validation) || value.validation.some((item) => typeof item !== "string")) throw new Error("invalid explicit story contract");
  return value as StoryContract;
}

function loadInstructions(path: string): string[] { const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 10_000)) throw new Error("invalid instruction file"); return value; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runOrchestrator().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
