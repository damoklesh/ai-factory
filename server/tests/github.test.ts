import test from "node:test";
import assert from "node:assert/strict";
import { GitHubSyncAdapter } from "../src/github.js";
import type { StoryDetail } from "@ai-factory/contracts";

test("maps GitHub issues, pull requests and checks without exposing the token", async () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const adapter = new GitHubSyncAdapter("acme", "factory", "secret-token", async (input, init) => {
    requests.push({ url: input, authorization: String(new Headers(init?.headers).get("Authorization")) });
    if (input.endsWith("/issues?state=all&per_page=100")) return new Response(JSON.stringify([{ number: 7, state: "open" }]));
    if (input.endsWith("/pulls?state=all&per_page=100")) return new Response(JSON.stringify([{ number: 12, state: "open", merged_at: null, title: "Implement #7", body: "", head: { ref: "agent/issue-7", sha: "abc123" } }]));
    return new Response(JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success", head_sha: "abc123" }] }));
  });
  const story = { storyId: "US-007", githubIssueNumber: 7 } as StoryDetail;
  const observations = await adapter.observe([story]);
  assert.deepEqual(observations[0], { storyId: "US-007", pullRequestNumber: 12, headSha: "abc123", state: "OPEN", checks: "PASS", checkedAt: observations[0].checkedAt });
  assert.equal(requests.every((request) => request.authorization === "Bearer secret-token"), true);
  assert.doesNotMatch(JSON.stringify(observations), /secret-token/);
});
