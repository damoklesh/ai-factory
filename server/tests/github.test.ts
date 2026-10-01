import test from "node:test";
import assert from "node:assert/strict";
import { GitHubSyncAdapter } from "../src/github.js";
import type { StoryDetail } from "@ai-factory/contracts";

test("maps GitHub issues, pull requests and checks without exposing the token", async () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const adapter = new GitHubSyncAdapter("acme", "factory", "secret-token", async (input, init) => {
    requests.push({ url: input, authorization: String(new Headers(init?.headers).get("Authorization")) });
    if (input.endsWith("/issues?state=all&per_page=100")) return new Response(JSON.stringify([{ number: 7, state: "open", title: "[US-007] Salary", body: "<!-- AI_FACTORY_STORY_ID: US-007 -->" }]));
    if (input.endsWith("/pulls?state=all&per_page=100")) return new Response(JSON.stringify([{ number: 12, state: "open", merged_at: null, title: "Implement #7", body: "", head: { ref: "agent/issue-7", sha: "abc123" } }]));
    if (input.endsWith("/actions/runs?head_sha=abc123&per_page=100")) return new Response(JSON.stringify({ workflow_runs: [{ id: 21, name: "Validate", status: "completed", conclusion: "success", head_sha: "abc123" }] }));
    if (input.endsWith("/actions/runs/21/jobs?per_page=100")) return new Response(JSON.stringify({ jobs: [{ name: "validate", status: "completed", conclusion: "success", head_sha: "abc123" }] }));
    return new Response(JSON.stringify({ workflow_runs: [] }));
  });
  const story = { storyId: "US-007" } as StoryDetail;
  const observations = await adapter.observe([story]);
  assert.deepEqual(observations[0], { storyId: "US-007", githubIssueNumber: 7, pullRequestNumber: 12, headSha: "abc123", state: "OPEN", checks: "PASS", checkedAt: observations[0].checkedAt });
  assert.equal(requests.some((request) => request.url.includes("/check-runs")), false);
  assert.equal(requests.every((request) => request.authorization === "Bearer secret-token"), true);
  assert.doesNotMatch(JSON.stringify(observations), /secret-token/);
});

test("creates and updates Issues with labels while keeping authorization out of results", async () => {
  const calls: Array<{ method: string; body: string; authorization: string }> = [];
  const adapter = new GitHubSyncAdapter("acme", "factory", "private-token", async (_input, init) => {
    calls.push({ method: init?.method || "GET", body: String(init?.body || ""), authorization: String(new Headers(init?.headers).get("Authorization")) });
    const input = JSON.parse(String(init?.body)) as { title: string; body: string; labels: string[] };
    return new Response(JSON.stringify({ number: 4, state: "open", title: input.title, body: input.body, labels: input.labels.map((name) => ({ name })) }));
  });
  const created = await adapter.createIssue({ title: "[US-004] Test", body: "<!-- ai-factory:story-id=US-004 -->", labels: ["agent:ready"] });
  const updated = await adapter.updateIssue(4, { title: created.title, body: `${created.body}\nupdated`, labels: created.labels });
  assert.deepEqual(calls.map((item) => item.method), ["POST", "PATCH"]);
  assert.equal(calls.every((item) => item.authorization === "Bearer private-token"), true);
  assert.deepEqual(updated.labels, ["agent:ready"]);
  assert.doesNotMatch(JSON.stringify([created, updated]), /private-token/);
});
