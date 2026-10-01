import type { GitHubClient } from "./github.js";
import type { CheckRun, ReviewThread } from "./types.js";
import { checkNameMatches } from "./checks.js";

export interface MergeGateInput { currentSha: string; reviewedSha?: string; reviewDecision: "PASS" | "CHANGES_REQUESTED" | "NEEDS_HUMAN"; checks: CheckRun[]; requiredChecks: string[]; reviewThreads: { available: boolean; threads: ReviewThread[]; reason?: string }; }
export interface MergeGateResult { ready: boolean; reason?: string; }

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  if (input.requiredChecks.length === 0) return { ready: false, reason: "no required checks configured; configure at least one required check before proceeding" };
  if (!input.reviewedSha || input.reviewedSha !== input.currentSha) return { ready: false, reason: "review is stale or missing for current SHA" };
  if (input.reviewDecision !== "PASS") return { ready: false, reason: `review decision is ${input.reviewDecision}` };
  const current = input.checks.filter((check) => check.headSha === input.currentSha);
  const missing = input.requiredChecks.filter((name) => !current.some((check) => checkNameMatches(check.name, name)));
  if (missing.length) return { ready: false, reason: `required checks missing for current SHA: ${missing.join(", ")}` };
  const notGreen = current.filter((check) => input.requiredChecks.some((name) => checkNameMatches(check.name, name)) && (check.status !== "completed" || check.conclusion !== "success"));
  if (notGreen.length) return { ready: false, reason: `required checks are not green: ${notGreen.map((check) => check.name).join(", ")}` };
  if (!input.reviewThreads.available) return { ready: false, reason: `review thread data unavailable${input.reviewThreads.reason ? `: ${input.reviewThreads.reason}` : ""}` };
  const unresolved = input.reviewThreads.threads.filter((thread) => thread.headSha === input.currentSha && thread.blocking && !thread.resolved);
  if (unresolved.length) return { ready: false, reason: `${unresolved.length} unresolved blocking review thread(s)` };
  return { ready: true };
}

export async function mergeReviewedPullRequest(client: GitHubClient, pullRequestNumber: number, reviewedSha: string): Promise<{ merged: boolean; message: string }> {
  const current = await client.getPullRequest(pullRequestNumber);
  if (current.headSha !== reviewedSha) throw new Error(`reviewed SHA ${reviewedSha} is stale; current PR SHA is ${current.headSha}`);
  return client.mergePullRequest(pullRequestNumber, reviewedSha);
}
