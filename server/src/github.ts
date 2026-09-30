import type { GithubObservation, StoryDetail } from "@ai-factory/contracts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Issue = { number: number; state: "open" | "closed"; title: string; body: string | null };
type PullRequest = { number: number; state: "open" | "closed"; merged_at: string | null; body: string | null; title: string; head: { ref: string; sha: string } };
type CheckRun = { status: "queued" | "in_progress" | "completed"; conclusion: string | null; head_sha: string };

export class GitHubSyncAdapter {
  private readonly apiRoot = "https://api.github.com";
  constructor(private readonly owner: string, private readonly repo: string, private readonly token: string, private readonly fetcher: FetchLike = fetch) {}

  async observe(stories: StoryDetail[]): Promise<GithubObservation[]> {
    const issues = await this.request<Issue[]>(`/issues?state=all&per_page=100`);
    const pullRequests = await this.request<PullRequest[]>(`/pulls?state=all&per_page=100`);
    const observations: GithubObservation[] = [];
    for (const story of stories) {
      if (!story.githubIssueNumber) continue;
      const issue = issues.find((item) => item.number === story.githubIssueNumber) || issues.find((item) => item.title.startsWith(`[${story.storyId}]`) || (item.body || "").includes(`AI_FACTORY_STORY_ID: ${story.storyId}`));
      const issueNumber = story.githubIssueNumber || issue?.number;
      if (!issueNumber) continue;
      const pullRequest = pullRequests.find((item) => item.number === story.pullRequestNumber) || pullRequests.find((item) => {
        const marker = `#${issueNumber}`;
        return item.head.ref === `agent/issue-${issueNumber}` || item.title.includes(marker) || (item.body || "").includes(marker);
      });
      const checkedAt = new Date().toISOString();
      if (!pullRequest) {
        observations.push({ storyId: story.storyId, githubIssueNumber: issueNumber, state: issue?.state === "closed" ? "CLOSED" : "OPEN", checks: "UNKNOWN", checkedAt });
        continue;
      }
      const checks = await this.request<{ check_runs: CheckRun[] }>(`/commits/${encodeURIComponent(pullRequest.head.sha)}/check-runs`);
      observations.push({ storyId: story.storyId, githubIssueNumber: issueNumber, pullRequestNumber: pullRequest.number, headSha: pullRequest.head.sha, state: pullRequest.merged_at ? "MERGED" : pullRequest.state === "open" ? "OPEN" : "CLOSED", checks: checkStatus(checks.check_runs), checkedAt });
    }
    return observations;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.apiRoot}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
    return await response.json() as T;
  }
}

function checkStatus(checks: CheckRun[]): GithubObservation["checks"] {
  if (!checks.length) return "UNKNOWN";
  if (checks.some((check) => check.status === "completed" && check.conclusion !== "success" && check.conclusion !== "neutral" && check.conclusion !== "skipped")) return "FAIL";
  return checks.every((check) => check.status === "completed") ? "PASS" : "PENDING";
}
