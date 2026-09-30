import test from "node:test";
import assert from "node:assert/strict";
import { parseStory, selectNextStory, validateDependencyGraph } from "../src/stories.js";
import { emptyState, canStartFix, reconcilePullRequest, transition } from "../src/state.js";
import { parseReviewResult, validateDeveloperResult } from "../src/result.js";
import { evaluateRequiredChecks } from "../src/checks.js";
import { buildPullRequestBody, replaceAgentLabel } from "../src/github.js";
import { parseArgs } from "../src/orchestrator.js";
import { mergeReviewedPullRequest } from "../src/merge.js";
import { waitForRequiredChecks } from "../src/verify.js";
import type { GitHubClient } from "../src/github.js";
import type { Issue } from "../src/types.js";

const issue = (number: number, priority: number, dependencies = "None"): Issue => ({
  number, title: `US ${number}`, state: "open", labels: ["agent:ready"], body: `## Objective\nAs a user I want story ${number}.\n## Acceptance criteria\n- It works\n- It handles errors\n## Scope\nController\n## Dependencies\n${dependencies}\n## Priority\n${priority}\n## Validation\nnpm test`,
});

test("parses the issue contract and orders eligible stories", () => {
  const result = parseStory(issue(2, 1, "#1, #3"));
  assert.deepEqual(result.dependencies, [1, 3]);
  assert.equal(selectNextStory([issue(2, 1, "#1"), issue(1, 2)], new Set())?.issue.number, 1);
  assert.equal(selectNextStory([issue(2, 1, "#1"), issue(1, 2)], new Set([1]))?.issue.number, 2);
});

test("blocks missing and cyclic dependencies", () => {
  assert.match(validateDependencyGraph([issue(2, 1, "#9")])[0], /missing #9/);
  assert.ok(validateDependencyGraph([issue(1, 1, "#2"), issue(2, 2, "#1")]).some((item) => item.includes("cycle")));
});

test("reconciles an existing stable PR and enforces fix limits", () => {
  const state = emptyState();
  transition(state, 7, "IMPLEMENTING", { fixCycles: 2 });
  const reconciled = reconcilePullRequest(state, 7, [{ number: 10, title: "US", headBranch: "agent/issue-7", headSha: "abc", baseBranch: "main", state: "open", merged: false, body: "" }]);
  assert.equal(reconciled?.pullRequestNumber, 10);
  assert.equal(reconciled?.status, "PR_OPEN");
  assert.equal(canStartFix(reconciled!, 3), true);
  assert.equal(canStartFix(reconciled!, 2), false);
});

test("rejects malformed agent results", () => {
  assert.throws(() => validateDeveloperResult({ summary: "done", tests: [] }), /schema/);
  assert.throws(() => parseReviewResult({ decision: "PASS", findings: [] }), /schema/);
  assert.equal(parseReviewResult({ decision: "PASS", findings: [], evidence: ["npm test"] }).decision, "PASS");
});

test("evaluates checks only for the current head SHA", () => {
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "completed", conclusion: "success", headSha: "old" }], ["CI"], "new").decision, "WAIT");
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "completed", conclusion: "failure", headSha: "new" }], ["CI"], "new").decision, "FAIL");
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "completed", conclusion: "success", headSha: "new" }], ["CI"], "new").decision, "PASS");
});

test("uses stable issue branches and preserves non-agent labels", () => {
  assert.deepEqual(replaceAgentLabel(["bug", "agent:ready", "agent:blocked"], "agent:running"), ["bug", "agent:running"]);
  assert.match(buildPullRequestBody(12, "agent/issue-12"), /Issue: #12/);
  assert.equal(parseArgs(["--max-stories", "2", "--auto-merge"]).autoMerge, true);
});

test("waits for current-SHA CI and blocks a changed PR head at merge", async () => {
  let calls = 0;
  const client = {
    async getChecks() { calls += 1; return calls === 1 ? [{ name: "CI", status: "in_progress", conclusion: null, headSha: "new" }] : [{ name: "CI", status: "completed", conclusion: "success", headSha: "new" }]; },
    async getPullRequest() { return { number: 12, title: "US", body: "", state: "open" as const, merged: false, headBranch: "agent/issue-12", headSha: "changed", baseBranch: "main" }; },
    async mergePullRequest() { throw new Error("must not merge a stale SHA"); },
  } as unknown as GitHubClient;
  const result = await waitForRequiredChecks(client, "new", ["CI"], 1000, 0);
  assert.equal(result.decision, "PASS");
  await assert.rejects(() => mergeReviewedPullRequest(client, 12, "reviewed"), /stale/);
});
