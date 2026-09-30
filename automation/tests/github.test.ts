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
    if (url.endsWith("/commits/sha-1/check-runs")) return Response.json({ check_runs: [{ name: "CI", status: "completed", conclusion: "success", head_sha: "sha-1" }] });
    if (method === "POST" && url.endsWith("/pulls")) return Response.json({ number: 10, title: "New", body: "body", state: "open", head: { ref: "agent/issue-10", sha: "sha-10" }, base: { ref: "main" } });
    if (method === "PUT" && url.endsWith("/merge")) return Response.json({ merged: true, message: "Merged" });
    return new Response(null, { status: 204 });
  };
  try {
    const client = new RestGitHubClient("owner", "repo", "secret-that-must-not-be-printed");
    assert.deepEqual((await client.listIssues()).map((item) => item.number), [1]);
    assert.equal((await client.listPullRequests("agent/issue-1"))[0].headSha, "sha-1");
    assert.equal((await client.getPullRequest(9)).number, 9);
    assert.equal((await client.getChecks("sha-1"))[0].conclusion, "success");
    assert.equal((await client.createIssue({ title: "New issue", body: "body", labels: ["agent:ready"] })).number, 11);
    assert.equal((await client.createPullRequest({ title: "New", body: "body", headBranch: "agent/issue-10", baseBranch: "main" })).number, 10);
    await client.setIssueLabels(1, ["agent:running"]);
    await client.closeIssue(1);
    await client.comment(1, "structured comment");
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
