import type { GitHubClient } from "./github.js";

export async function mergeReviewedPullRequest(client: GitHubClient, pullRequestNumber: number, reviewedSha: string): Promise<{ merged: boolean; message: string }> {
  const current = await client.getPullRequest(pullRequestNumber);
  if (current.headSha !== reviewedSha) throw new Error(`reviewed SHA ${reviewedSha} is stale; current PR SHA is ${current.headSha}`);
  return client.mergePullRequest(pullRequestNumber, reviewedSha);
}

