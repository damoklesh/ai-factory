import type { CheckRun, Issue, PullRequest, ReviewThread } from "./types.js";

export interface GitHubClient {
  listIssues(): Promise<Issue[]>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<Issue>;
  updateIssue(number: number, input: { title: string; body: string }): Promise<Issue>;
  listPullRequests(branch: string): Promise<PullRequest[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  getChecks(headSha: string): Promise<CheckRun[]>;
  createPullRequest(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<PullRequest>;
  updatePullRequest?(number: number, input: { title: string; body: string }): Promise<PullRequest>;
  publishPullRequestReview?(number: number, input: { body: string; changesRequested: boolean; idempotencyKey: string }): Promise<{ url?: string }>;
  getReviewThreads?(number: number, headSha: string): Promise<{ available: boolean; threads: ReviewThread[]; reason?: string }>;
  setIssueLabels(issueNumber: number, labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
  mergePullRequest(number: number, expectedSha: string): Promise<{ merged: boolean; message: string; sha?: string }>;
}

export function replaceAgentLabel(labels: string[], next: "agent:ready" | "agent:running" | "agent:blocked" | "agent:done"): string[] {
  return [...new Set([...labels.filter((label) => !label.startsWith("agent:")), next])];
}

export function buildPullRequestBody(issueNumber: number, branch: string, details: { storyId?: string; objective?: string; acceptanceCriteria?: string[]; validation?: Array<{ command: string; passed: boolean; output?: string }>; sourceIssueUrl?: string } = {}): string {
  const criteria = details.acceptanceCriteria?.length ? details.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- See the linked story contract";
  const validation = details.validation?.length ? details.validation.map((item) => `- ${item.passed ? "PASS" : "FAIL"} ${item.command}${item.output ? `: ${item.output.slice(0, 500)}` : ""}`).join("\n") : "- No validation commands configured";
  return [
    "AI Factory managed PR",
    "",
    `- Story: ${details.storyId || `US-${String(issueNumber).padStart(3, "0")}`}`,
    `- Issue: #${issueNumber}${details.sourceIssueUrl ? ` (${details.sourceIssueUrl})` : ""}`,
    `- Branch: ${branch}`,
    "- Controller: trusted-base-v1",
    "",
    "## Objective",
    details.objective || "See the linked story contract.",
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Validation",
    validation,
    "",
    "The controller owns commit, verification, review, and merge transitions.",
  ].join("\n");
}

export class RestGitHubClient implements GitHubClient {
  private readonly apiRoot = "https://api.github.com";
  constructor(private readonly owner: string, private readonly repo: string, private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.apiRoot}${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText} at ${path}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private path(value: string): string { return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${value}`; }

  async listIssues(): Promise<Issue[]> {
    const values = await this.request<Array<{ number: number; title: string; body: string | null; state: "open" | "closed"; labels: Array<{ name?: string }> ; pull_request?: unknown }>>(this.path("/issues?state=all&per_page=100"));
    return values.filter((item) => !item.pull_request).map((item) => ({ number: item.number, title: item.title, body: item.body || "", state: item.state, labels: item.labels.map((label) => label.name || "") }));
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<Issue> {
    const item = await this.request<{ number: number; title: string; body: string | null; state: "open" | "closed"; labels: Array<{ name?: string }> }>(this.path("/issues"), { method: "POST", body: JSON.stringify(input) });
    return { number: item.number, title: item.title, body: item.body || "", state: item.state, labels: item.labels.map((label) => label.name || "") };
  }

  async updateIssue(number: number, input: { title: string; body: string }): Promise<Issue> {
    const item = await this.request<{ number: number; title: string; body: string | null; state: "open" | "closed"; labels: Array<{ name?: string }> }>(this.path(`/issues/${number}`), { method: "PATCH", body: JSON.stringify(input) });
    return { number: item.number, title: item.title, body: item.body || "", state: item.state, labels: item.labels.map((label) => label.name || "") };
  }

  async listPullRequests(branch: string): Promise<PullRequest[]> {
    const values = await this.request<Array<{ number: number; title: string; body: string | null; state: "open" | "closed"; merged_at: string | null; head: { ref: string; sha: string }; base: { ref: string } }>>(this.path(`/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=100`));
    return values.map((item) => ({ number: item.number, title: item.title, body: item.body || "", state: item.state, merged: Boolean(item.merged_at), headBranch: item.head.ref, headSha: item.head.sha, baseBranch: item.base.ref }));
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const item = await this.request<{ number: number; title: string; body: string | null; state: "open" | "closed"; merged_at: string | null; head: { ref: string; sha: string }; base: { ref: string } }>(this.path(`/pulls/${number}`));
    return { number: item.number, title: item.title, body: item.body || "", state: item.state, merged: Boolean(item.merged_at), headBranch: item.head.ref, headSha: item.head.sha, baseBranch: item.base.ref };
  }

  async getChecks(headSha: string): Promise<CheckRun[]> {
    const result = await this.request<{ check_runs: Array<{ name: string; status: CheckRun["status"]; conclusion: string | null; head_sha: string }> }>(this.path(`/commits/${encodeURIComponent(headSha)}/check-runs`));
    return result.check_runs.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, headSha: check.head_sha }));
  }

  async createPullRequest(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<PullRequest> {
    const item = await this.request<{ number: number; title: string; body: string | null; state: "open" | "closed"; head: { ref: string; sha: string }; base: { ref: string } }>(this.path("/pulls"), { method: "POST", body: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch }) });
    return { number: item.number, title: item.title, body: item.body || "", state: item.state, merged: false, headBranch: item.head.ref, headSha: item.head.sha, baseBranch: item.base.ref };
  }
  async updatePullRequest(number: number, input: { title: string; body: string }): Promise<PullRequest> {
    const item = await this.request<{ number: number; title: string; body: string | null; state: "open" | "closed"; merged_at: string | null; head: { ref: string; sha: string }; base: { ref: string } }>(this.path(`/pulls/${number}`), { method: "PATCH", body: JSON.stringify(input) });
    return { number: item.number, title: item.title, body: item.body || "", state: item.state, merged: Boolean(item.merged_at), headBranch: item.head.ref, headSha: item.head.sha, baseBranch: item.base.ref };
  }
  async publishPullRequestReview(number: number, input: { body: string; changesRequested: boolean; idempotencyKey: string }): Promise<{ url?: string }> {
    const item = await this.request<{ html_url?: string }>(this.path(`/pulls/${number}/reviews`), { method: "POST", body: JSON.stringify({ body: `[ai-factory-review:${input.idempotencyKey}]\n\n${input.body}`, event: input.changesRequested ? "REQUEST_CHANGES" : "COMMENT" }) });
    return { url: item.html_url };
  }
  async getReviewThreads(number: number, headSha: string): Promise<{ available: boolean; threads: ReviewThread[]; reason?: string }> {
    const comments = await this.request<Array<{ id: number; body?: string; path?: string; line?: number | null; commit_id?: string; resolved?: boolean; blocking?: boolean }>>(this.path(`/pulls/${number}/comments`));
    const relevant = comments.filter((comment) => !comment.commit_id || comment.commit_id === headSha);
    const unknownResolution = relevant.some((comment) => typeof comment.resolved !== "boolean");
    if (unknownResolution && relevant.length) return { available: false, threads: [], reason: "GitHub review-thread resolution is unavailable" };
    return { available: true, threads: relevant.map((comment) => ({ id: String(comment.id), headSha: comment.commit_id || headSha, blocking: comment.blocking === true || /^\s*\[blocking\]/i.test(comment.body || ""), resolved: comment.resolved === true, body: comment.body, file: comment.path, line: comment.line || undefined })) };
  }

  async setIssueLabels(issueNumber: number, labels: string[]): Promise<void> { await this.request(this.path(`/issues/${issueNumber}/labels`), { method: "PUT", body: JSON.stringify({ labels }) }); }
  async closeIssue(issueNumber: number): Promise<void> { await this.request(this.path(`/issues/${issueNumber}`), { method: "PATCH", body: JSON.stringify({ state: "closed" }) }); }
  async comment(issueNumber: number, body: string): Promise<void> { await this.request(this.path(`/issues/${issueNumber}/comments`), { method: "POST", body: JSON.stringify({ body }) }); }
  async mergePullRequest(number: number, expectedSha: string): Promise<{ merged: boolean; message: string; sha?: string }> { return await this.request(this.path(`/pulls/${number}/merge`), { method: "PUT", body: JSON.stringify({ sha: expectedSha, merge_method: "squash" }) }); }
}
