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

export type FixCycleCause = "LOCAL_VALIDATION" | "CI_FAILURE" | "REVIEW_CHANGES_REQUESTED";

/** Local implementation retries are unbounded by the review correction budget. */
export function nextFixCycle(current: number, cause: FixCycleCause): number {
  return cause === "LOCAL_VALIDATION" ? current : current + 1;
}
