import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PersistedState, PullRequest, StoryState, StoryStatus } from "./types.js";

export function emptyState(): PersistedState { return { stories: {} }; }

export async function loadState(filePath: string): Promise<PersistedState> {
  try {
    const value = JSON.parse(await readFile(resolve(filePath), "utf8")) as PersistedState;
    return value && typeof value.stories === "object" ? value : emptyState();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(filePath: string, state: PersistedState): Promise<void> {
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function transition(state: PersistedState, issueNumber: number, status: StoryStatus, values: Partial<StoryState> = {}): StoryState {
  const current = state.stories[String(issueNumber)];
  const next: StoryState = {
    ...current,
    issueNumber,
    branch: current?.branch || `agent/issue-${issueNumber}`,
    fixCycles: current?.fixCycles || 0,
    ...values,
    status,
    updatedAt: new Date().toISOString(),
  };
  state.stories[String(issueNumber)] = next;
  return next;
}

export function reconcilePullRequest(state: PersistedState, issueNumber: number, pullRequests: PullRequest[]): StoryState | undefined {
  const branch = `agent/issue-${issueNumber}`;
  const existing = pullRequests.find((pullRequest) => pullRequest.headBranch === branch && pullRequest.state === "open");
  if (!existing) return state.stories[String(issueNumber)];
  return transition(state, issueNumber, "PR_OPEN", {
    branch,
    pullRequestNumber: existing.number,
    headSha: existing.headSha,
  });
}

export function canStartFix(state: StoryState, maxFixCycles: number): boolean {
  return state.fixCycles < maxFixCycles;
}

/**
 * A resumed pull request should go back through validation and review unless
 * the persisted state explicitly says that developer work is required. This
 * keeps a restart from spending another fix cycle on a PR that was already
 * published and is merely waiting for review/checks.
 */
export function shouldRunDeveloper(pullRequestExists: boolean, previous?: StoryState, explicitResume = false): boolean {
  if (!pullRequestExists) return true;
  if (!previous) return false;
  if (previous.status === "REVIEW_CHANGES_REQUESTED" || previous.fixCause === "REVIEW_CHANGES_REQUESTED" || previous.fixCause === "CI_FAILURE") return true;
  // A manually resumed human-blocked review may continue with a fresh bounded
  // correction budget. This is never selected automatically.
  return explicitResume && previous.status === "NEEDS_HUMAN" && Boolean(previous.reviewFindings?.length);
}

export type FixCycleCause = "LOCAL_VALIDATION" | "CI_FAILURE" | "REVIEW_CHANGES_REQUESTED";

/** Local implementation retries do not consume the review correction budget; the orchestrator bounds them separately. */
export function nextFixCycle(current: number, cause: FixCycleCause): number {
  return cause === "LOCAL_VALIDATION" ? current : current + 1;
}
