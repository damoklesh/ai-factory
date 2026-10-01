import test from "node:test";
import assert from "node:assert/strict";
import { RestGitHubClient } from "../src/github.js";

test("maps GitHub REST resources and filters pull-request issues", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method });
    if (url.endsWith("/issues?state=all&per_page=100")) return Response.json([
      { number: 1, title: "US", body: null, state: "open", labels: [{ name: "agent:ready" }] },
      { number: 2, title: "PR mirror", body: "", state: "open", labels: [], pull_request: {} },
    ]);
    if (url.includes("/pulls?state=open")) return Response.json([{ number: 9, title: "US", body: "body", state: "open", merged_at: null, head: { ref: "agent/issue-1", sha: "sha-1" }, base: { ref: "main" } }]);
    if (url.endsWith("/pulls/9")) return Response.json({ number: 9, title: "US", body: "body", state: "open", merged_at: null, head: { ref: "agent/issue-1", sha: "sha-1" }, base: { ref: "main" } });
    if (method === "POST" && url.endsWith("/issues")) return Response.json({ number: 11, title: "New issue", body: "body", state: "open", labels: [{ name: "agent:ready" }] });
    if (method === "PATCH" && url.endsWith("/issues/1")) return Response.json({ number: 1, title: "Updated", body: "updated", state: "open", labels: [{ name: "agent:ready" }] });
    if (url.endsWith("/actions/runs?head_sha=sha-1&per_page=100")) return Response.json({ workflow_runs: [{ id: 42, name: "Validate", status: "completed", conclusion: "success", head_sha: "sha-1" }] });
    if (url.endsWith("/actions/runs/42/jobs?per_page=100")) return Response.json({ jobs: [{ name: "CI", status: "completed", conclusion: "success", head_sha: "sha-1" }] });
    if (method === "POST" && url.endsWith("/pulls")) return Response.json({ number: 10, title: "New", body: "body", state: "open", head: { ref: "agent/issue-10", sha: "sha-10" }, base: { ref: "main" } });
    if (method === "POST" && url.endsWith("/pulls/9/reviews")) return Response.json({ html_url: "https://github.com/owner/repo/pull/9#review" });
    if (method === "PUT" && url.endsWith("/merge")) return Response.json({ merged: true, message: "Merged" });
    return new Response(null, { status: 204 });
  };
  try {
    const client = new RestGitHubClient("owner", "repo", "secret-that-must-not-be-printed");
    assert.deepEqual((await client.listIssues()).map((item) => item.number), [1]);
    assert.equal((await client.listPullRequests("agent/issue-1"))[0].headSha, "sha-1");
    assert.equal((await client.getPullRequest(9)).number, 9);
    assert.equal((await client.getChecks("sha-1"))[0].conclusion, "success");
    assert.equal(calls.some((call) => call.url.includes("/check-runs")), false);
    assert.equal((await client.createIssue({ title: "New issue", body: "body", labels: ["agent:ready"] })).number, 11);
    assert.equal((await client.createPullRequest({ title: "New", body: "body", headBranch: "agent/issue-10", baseBranch: "main" })).number, 10);
    await client.setIssueLabels(1, ["agent:running"]);
    await client.closeIssue(1);
    await client.comment(1, "structured comment");
    assert.equal((await client.publishPullRequestReview(9, { body: "No findings", changesRequested: false, idempotencyKey: "run:cycle:sha" })).url, "https://github.com/owner/repo/pull/9#review");
    assert.equal((await client.mergePullRequest(9, "sha-1")).merged, true);
    assert.equal(calls.some((call) => call.url.includes("secret-that-must-not-be-printed")), false);
    assert.ok(calls.some((call) => call.method === "PATCH"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces GitHub API errors without exposing the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("denied", { status: 403, statusText: "Forbidden" });
  try {
    const client = new RestGitHubClient("owner", "repo", "secret");
    await assert.rejects(() => client.listIssues(), /GitHub API 403 Forbidden/);
    await assert.rejects(() => client.listIssues(), (error: Error) => !error.message.includes("secret"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to an auditable PR conversation comment when native review is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push(`${init?.method || "GET"} ${url}`);
    if (url.endsWith("/pulls/35/reviews")) return new Response("review author is not allowed", { status: 422, statusText: "Unprocessable Entity" });
    if (url.endsWith("/issues/35/comments")) return Response.json({ html_url: "https://github.com/owner/repo/pull/35#issuecomment-1" });
    return new Response(null, { status: 204 });
  };
  try {
    const client = new RestGitHubClient("owner", "repo", "secret");
    const result = await client.publishPullRequestReview(35, { body: "Changes requested", changesRequested: true, idempotencyKey: "run:cycle:sha" });
    assert.equal(result.url, "https://github.com/owner/repo/pull/35#issuecomment-1");
    assert.deepEqual(calls, ["POST https://api.github.com/repos/owner/repo/pulls/35/reviews", "POST https://api.github.com/repos/owner/repo/issues/35/comments"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not treat ordinary REST review comments as unresolved blockers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/pulls/35/comments")) return Response.json([
      { id: 1, body: "Consider a clearer name", commit_id: "sha-35" },
      { id: 2, body: "[blocking] This must be corrected", commit_id: "sha-35" },
    ]);
    return new Response(null, { status: 204 });
  };
  try {
    const client = new RestGitHubClient("owner", "repo", "secret");
    const result = await client.getReviewThreads(35, "sha-35");
    assert.equal(result.available, true);
    assert.deepEqual(result.threads.map((thread) => ({ id: thread.id, blocking: thread.blocking, resolved: thread.resolved })), [{ id: "2", blocking: true, resolved: false }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the latest Actions attempt and accepts GitHub display names", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/actions/runs?head_sha=sha-2&per_page=100")) return Response.json({ workflow_runs: [
      { id: 10, name: "CI", status: "in_progress", conclusion: null, head_sha: "sha-2", updated_at: "2026-01-01T00:00:00Z" },
      { id: 11, name: "CI", status: "completed", conclusion: "success", head_sha: "sha-2", updated_at: "2026-01-01T00:01:00Z" },
    ] });
    if (url.endsWith("/actions/runs/10/jobs?per_page=100")) return Response.json({ jobs: [{ name: "CI Gate", status: "in_progress", conclusion: null, head_sha: "sha-2" }] });
    if (url.endsWith("/actions/runs/11/jobs?per_page=100")) return Response.json({ jobs: [{ name: "CI / CI Gate (pull_request)", status: "completed", conclusion: "success", head_sha: "sha-2" }] });
    return new Response(null, { status: 204 });
  };
  try {
    const client = new RestGitHubClient("owner", "repo", "secret");
    const checks = await client.getChecks("sha-2");
    assert.deepEqual(checks, [{ name: "CI / CI Gate (pull_request)", status: "completed", conclusion: "success", headSha: "sha-2" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
