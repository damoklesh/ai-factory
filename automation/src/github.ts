import type { CheckRun, Issue, PullRequest } from "./types.js";

export interface GitHubClient {
  listIssues(): Promise<Issue[]>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<Issue>;
  listPullRequests(branch: string): Promise<PullRequest[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  getChecks(headSha: string): Promise<CheckRun[]>;
  createPullRequest(input: { title: string; body: string; headBranch: string; baseBranch: string }): Promise<PullRequest>;
  setIssueLabels(issueNumber: number, labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
  mergePullRequest(number: number, expectedSha: string): Promise<{ merged: boolean; message: string }>;
}

export function replaceAgentLabel(labels: string[], next: "agent:ready" | "agent:running" | "agent:blocked" | "agent:done"): string[] {
  return [...new Set([...labels.filter((label) => !label.startsWith("agent:")), next])];
}

export function buildPullRequestBody(issueNumber: number, branch: string): string {
  return `AI Factory managed PR\n\n- Issue: #${issueNumber}\n- Branch: ${branch}\n- Controller: trusted-base-v1\n\nThe controller owns commit, verification, review, and merge transitions.`;
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

  async setIssueLabels(issueNumber: number, labels: string[]): Promise<void> { await this.request(this.path(`/issues/${issueNumber}/labels`), { method: "PUT", body: JSON.stringify({ labels }) }); }
  async closeIssue(issueNumber: number): Promise<void> { await this.request(this.path(`/issues/${issueNumber}`), { method: "PATCH", body: JSON.stringify({ state: "closed" }) }); }
  async comment(issueNumber: number, body: string): Promise<void> { await this.request(this.path(`/issues/${issueNumber}/comments`), { method: "POST", body: JSON.stringify({ body }) }); }
  async mergePullRequest(number: number, expectedSha: string): Promise<{ merged: boolean; message: string }> { return await this.request(this.path(`/pulls/${number}/merge`), { method: "PUT", body: JSON.stringify({ sha: expectedSha, merge_method: "squash" }) }); }
}
