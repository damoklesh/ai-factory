import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { CodexRunError, CodexRunner } from "./codex.js";
import { buildPullRequestBody, replaceAgentLabel, RestGitHubClient, type GitHubClient } from "./github.js";
import { commitAndPush, createWorktree, gitDiff, gitRoot, removeWorktree, ensureTargetRepository, type Worktree } from "./git.js";
import { backlogPath, syncBacklog } from "./backlog.js";
import { loadState, saveState, transition, canStartFix } from "./state.js";
import { mergeReviewedPullRequest } from "./merge.js";
import { parseStory, selectNextStory } from "./stories.js";
import { runValidation, validationsPassed, waitForRequiredChecks } from "./verify.js";
import type { Issue, OrchestrationConfig, PullRequest, StoryContract, StoryState } from "./types.js";

export interface CliOptions { configPath: string; dryRun: boolean; mock: boolean; syncBacklog: boolean; maxStories?: number; autoMerge?: boolean; }

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
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.maxStories !== undefined && (!Number.isInteger(options.maxStories) || options.maxStories < 1)) throw new Error("--max-stories must be a positive integer");
  return options;
}

function storyPrompt(issue: Issue, contract: StoryContract, feedback = ""): string {
  return [`Implement GitHub Issue #${issue.number}: ${issue.title}`, `Objective: ${contract.objective}`, "Acceptance criteria:", ...contract.acceptanceCriteria.map((item) => `- ${item}`), `Scope: ${contract.scope}`, `Validation: ${contract.validation.join("; ") || "use configured validation commands"}`, feedback ? `Feedback from the previous gate:\n${feedback}` : "", "Work only in the current worktree. Do not change controller policy, CI protections, or credentials. End with the required JSON result."].filter(Boolean).join("\n");
}

function reviewPrompt(issue: Issue, contract: StoryContract, diff: string, validationOutput: string): string {
  return [`Review Issue #${issue.number}: ${issue.title}`, `Objective: ${contract.objective}`, "Acceptance criteria:", ...contract.acceptanceCriteria.map((item) => `- ${item}`), `Diff:\n${diff}`, `Validation evidence:\n${validationOutput}`, "Return only the review JSON. Do not modify files."].join("\n");
}

function formatFailure(state: StoryState, reason: string): string {
  return JSON.stringify({ issue: state.issueNumber, pr: state.pullRequestNumber || null, branch: state.branch, sha: state.headSha || null, cycle: state.fixCycles, reason });
}

async function mark(client: GitHubClient, issue: Issue, status: "agent:running" | "agent:blocked" | "agent:done"): Promise<void> {
  await client.setIssueLabels(issue.number, replaceAgentLabel(issue.labels, status));
}

async function processStory(client: GitHubClient, config: OrchestrationConfig, target: { path: string; controlRoot: string; env?: NodeJS.ProcessEnv }, issue: Issue, contract: StoryContract, stateFile: string): Promise<StoryStatusResult> {
  const state = await loadState(stateFile);
  const branch = `agent/issue-${issue.number}`;
  const root = target.path;
  let worktree: Worktree | undefined;
  let pullRequest: PullRequest | undefined = (await client.listPullRequests(branch))[0];
  let feedback = "";
  const previous = state.stories[String(issue.number)];
  const firstCycle = previous?.fixCycles || 0;
  transition(state, issue.number, "IMPLEMENTING", { branch, pullRequestNumber: pullRequest?.number });
  await saveState(stateFile, state);
  await mark(client, issue, "agent:running");
  try {
    worktree = await createWorktree(root, config.targetBranch, branch, { env: target.env });
    const codex = new CodexRunner(target.controlRoot, config.model);
    for (let cycle = firstCycle; cycle <= config.maxFixCycles; cycle += 1) {
      transition(state, issue.number, cycle === 0 ? "IMPLEMENTING" : "FIXING", { branch, fixCycles: cycle, pullRequestNumber: pullRequest?.number, reason: feedback || undefined });
      await saveState(stateFile, state);
      try {
        await codex.developer(storyPrompt(issue, contract, feedback), worktree.path, config.timeouts.codexMinutes * 60_000);
      } catch (error) {
        const kind = error instanceof CodexRunError ? error.kind : "FAILED";
        const status = kind === "AUTH" ? "PAUSED_AUTH" : kind === "QUOTA" ? "PAUSED_QUOTA" : "FAILED_INFRA";
        transition(state, issue.number, status, { reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state);
        await mark(client, issue, "agent:blocked");
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], state.stories[String(issue.number)].reason || "Codex failed"));
        return { status, state: state.stories[String(issue.number)] };
      }
      const validation = await runValidation(config.validationCommands, worktree.path, config.timeouts.workflowMinutes * 60_000);
      const validationText = validation.map((item) => `${item.passed ? "PASS" : "FAIL"} ${item.command}\n${item.output}`).join("\n");
      if (!validationsPassed(validation)) {
        feedback = `Local validation failed:\n${validationText}`;
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        continue;
      }
      const commit = await commitAndPush(worktree.path, branch, `feat: implement US #${issue.number}`, { env: target.env });
      if (!pullRequest) pullRequest = await client.createPullRequest({ title: issue.title, body: buildPullRequestBody(issue.number, branch), headBranch: branch, baseBranch: config.baseBranch });
      transition(state, issue.number, "PR_OPEN", { pullRequestNumber: pullRequest.number, headSha: commit.sha, branch, fixCycles: cycle });
      await saveState(stateFile, state);
      const checks = await waitForRequiredChecks(client, commit.sha, config.requiredChecks, config.timeouts.ciMinutes * 60_000);
      if (checks.decision === "FAIL") {
        feedback = `Required CI checks failed or timed out for SHA ${commit.sha}.`;
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], feedback));
        continue;
      }
      transition(state, issue.number, "REVIEWING", { headSha: commit.sha });
      await saveState(stateFile, state);
      const diff = await gitDiff(worktree.path, config.baseBranch);
      let review;
      try {
        review = await codex.reviewer(reviewPrompt(issue, contract, diff, validationText), worktree.path, config.timeouts.codexMinutes * 60_000);
      } catch (error) {
        transition(state, issue.number, "NEEDS_HUMAN", { reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], state.stories[String(issue.number)].reason || "Reviewer failed"));
        return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
      }
      transition(state, issue.number, "REVIEWING", { reviewHeadSha: commit.sha });
      if (review.decision === "NEEDS_HUMAN") {
        transition(state, issue.number, "NEEDS_HUMAN", { reason: review.findings.join("; ") || "Reviewer requested human decision" });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
      }
      if (review.decision === "CHANGES_REQUESTED") {
        feedback = review.findings.join("; ") || "Reviewer requested changes";
        transition(state, issue.number, "FIXING", { fixCycles: cycle + 1, reason: feedback });
        await saveState(stateFile, state);
        if (!canStartFix({ ...state.stories[String(issue.number)], fixCycles: cycle }, config.maxFixCycles)) break;
        await client.comment(issue.number, formatFailure(state.stories[String(issue.number)], feedback));
        continue;
      }
      if (!config.autoMerge) {
        transition(state, issue.number, "PR_OPEN", { headSha: commit.sha, reviewHeadSha: commit.sha });
        await saveState(stateFile, state);
        return { status: "PR_OPEN", state: state.stories[String(issue.number)] };
      }
      let merged;
      try {
        merged = await mergeReviewedPullRequest(client, pullRequest.number, commit.sha);
      } catch (error) {
        transition(state, issue.number, "NEEDS_HUMAN", { reason: error instanceof Error ? error.message : String(error) });
        await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
      }
      if (!merged.merged) {
        transition(state, issue.number, "NEEDS_HUMAN", { reason: merged.message }); await saveState(stateFile, state); await mark(client, issue, "agent:blocked");
        return { status: "NEEDS_HUMAN", state: state.stories[String(issue.number)] };
      }
      transition(state, issue.number, "DONE", { headSha: commit.sha, reviewHeadSha: commit.sha });
      await saveState(stateFile, state); await client.closeIssue(issue.number); await mark(client, issue, "agent:done");
      return { status: "DONE", state: state.stories[String(issue.number)] };
    }
    transition(state, issue.number, "NEEDS_HUMAN", { reason: `maximum fix cycles (${config.maxFixCycles}) exhausted` });
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
    console.log(`Target branch: ${config.targetBranch}; max stories: ${options.maxStories ?? config.maxStories}; autoMerge: ${options.autoMerge ?? config.autoMerge}`);
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
  for (let count = 0; count < effectiveConfig.maxStories; count += 1) {
    const selection = selectNextStory(issues, completed);
    if (!selection) { console.log("No eligible agent:ready story found."); break; }
    const result = await processStory(client, effectiveConfig, { ...target, controlRoot }, selection.issue, selection.contract, stateFile);
    console.log(`${result.status} #${selection.issue.number}${result.state.reason ? `: ${result.state.reason}` : ""}`);
    if (result.status === "DONE") completed.add(selection.issue.number); else break;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runOrchestrator().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
