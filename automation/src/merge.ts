import type { GitHubClient } from "./github.js";
import type { CheckRun } from "./types.js";

export interface MergeGateInput { currentSha: string; reviewedSha?: string; reviewDecision: "PASS" | "CHANGES_REQUESTED" | "NEEDS_HUMAN"; checks: CheckRun[]; requiredChecks: string[]; unresolvedBlockingComments?: number; }
export interface MergeGateResult { ready: boolean; reason?: string; }

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  if (!input.reviewedSha || input.reviewedSha !== input.currentSha) return { ready: false, reason: "review is stale or missing for current SHA" };
  if (input.reviewDecision !== "PASS") return { ready: false, reason: `review decision is ${input.reviewDecision}` };
  const current = input.checks.filter((check) => check.headSha === input.currentSha);
  const missing = input.requiredChecks.filter((name) => !current.some((check) => check.name === name));
  if (missing.length) return { ready: false, reason: `required checks missing for current SHA: ${missing.join(", ")}` };
  const notGreen = current.filter((check) => input.requiredChecks.includes(check.name) && (check.status !== "completed" || check.conclusion !== "success"));
  if (notGreen.length) return { ready: false, reason: `required checks are not green: ${notGreen.map((check) => check.name).join(", ")}` };
  if ((input.unresolvedBlockingComments || 0) > 0) return { ready: false, reason: `${input.unresolvedBlockingComments} unresolved blocking review comment(s)` };
  return { ready: true };
}

export async function mergeReviewedPullRequest(client: GitHubClient, pullRequestNumber: number, reviewedSha: string): Promise<{ merged: boolean; message: string }> {
  const current = await client.getPullRequest(pullRequestNumber);
  if (current.headSha !== reviewedSha) throw new Error(`reviewed SHA ${reviewedSha} is stale; current PR SHA is ${current.headSha}`);
  return client.mergePullRequest(pullRequestNumber, reviewedSha);
}
