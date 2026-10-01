import type { GithubObservation, StoryDetail } from "@ai-factory/contracts";
import type { IssueMirror } from "./backlog-sync.js";
import { issueStoryId } from "./backlog-sync.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ApiIssue = { number: number; state: "open" | "closed"; title: string; body: string | null; updated_at?: string; labels?: Array<string | { name?: string }>; pull_request?: unknown };
type PullRequest = { number: number; state: "open" | "closed"; merged_at: string | null; body: string | null; title: string; head: { ref: string; sha: string } };
type CheckRun = { status: "queued" | "in_progress" | "completed"; conclusion: string | null; head_sha: string };

export class GitHubSyncAdapter {
  private readonly apiRoot = "https://api.github.com";
  constructor(private readonly owner: string, private readonly repo: string, private readonly token: string, private readonly fetcher: FetchLike = fetch) {}

  async listIssues(): Promise<IssueMirror[]> {
    const issues = await this.request<ApiIssue[]>(`/issues?state=all&per_page=100`);
    return issues.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, state: issue.state, title: issue.title, body: issue.body || "", labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name || "").filter(Boolean), updatedAt: issue.updated_at }));
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueMirror> {
    return mapIssue(await this.request<ApiIssue>(`/issues`, { method: "POST", body: JSON.stringify(input) }));
  }

  async updateIssue(number: number, input: { title: string; body: string; labels: string[] }): Promise<IssueMirror> {
    return mapIssue(await this.request<ApiIssue>(`/issues/${number}`, { method: "PATCH", body: JSON.stringify(input) }));
  }

  async observe(stories: StoryDetail[]): Promise<GithubObservation[]> {
    const issues = await this.listIssues();
    const pullRequests = await this.request<PullRequest[]>(`/pulls?state=all&per_page=100`);
    const observations: GithubObservation[] = [];
    for (const story of stories) {
      const issue = issues.find((item) => issueStoryId(item) === story.storyId) || issues.find((item) => item.number === story.githubIssueNumber);
      const issueNumber = issue?.number || story.githubIssueNumber;
      if (!issueNumber) continue;
      const pullRequest = pullRequests.find((item) => item.number === story.pullRequestNumber) || pullRequests.find((item) => {
        const marker = `#${issueNumber}`;
        return item.head.ref === `agent/issue-${issueNumber}` || item.title.includes(marker) || (item.body || "").includes(marker);
      });
      const checkedAt = new Date().toISOString();
      if (!pullRequest) { observations.push({ storyId: story.storyId, githubIssueNumber: issueNumber, state: issue?.state === "closed" ? "CLOSED" : "OPEN", checks: "UNKNOWN", checkedAt }); continue; }
      const checks = await this.request<{ check_runs: CheckRun[] }>(`/commits/${encodeURIComponent(pullRequest.head.sha)}/check-runs`);
      observations.push({ storyId: story.storyId, githubIssueNumber: issueNumber, pullRequestNumber: pullRequest.number, headSha: pullRequest.head.sha, state: pullRequest.merged_at ? "MERGED" : pullRequest.state === "open" ? "OPEN" : "CLOSED", checks: checkStatus(checks.check_runs), checkedAt });
    }
    return observations;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.apiRoot}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) } });
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
    return await response.json() as T;
  }
}

function mapIssue(issue: ApiIssue): IssueMirror { return { number: issue.number, state: issue.state, title: issue.title, body: issue.body || "", labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name || "").filter(Boolean), updatedAt: issue.updated_at }; }
function checkStatus(checks: CheckRun[]): GithubObservation["checks"] { if (!checks.length) return "UNKNOWN"; if (checks.some((check) => check.status === "completed" && check.conclusion !== "success" && check.conclusion !== "neutral" && check.conclusion !== "skipped")) return "FAIL"; return checks.every((check) => check.status === "completed") ? "PASS" : "PENDING"; }
