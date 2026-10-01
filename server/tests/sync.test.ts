import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubObservation } from "@ai-factory/contracts";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";

test("reconciles external merge, push invalidation and closed PR without claiming DONE", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-sync-")); const backlog = join(root, "backlog"); await mkdir(backlog);
  await writeFile(join(backlog, "US-1.md"), "---\nstoryId: US-1\ntitle: First\nheadSha: old-sha\npullRequestNumber: 1\n---\n# First", "utf8");
  await writeFile(join(backlog, "US-2.md"), "---\nstoryId: US-2\ntitle: Second\n---\n# Second", "utf8");
  const checkedAt = new Date().toISOString(); const observations: GithubObservation[] = [
    { storyId: "US-1", pullRequestNumber: 1, headSha: "new-sha", validatedHeadSha: "old-sha", state: "OPEN", checks: "PASS", checkedAt },
    { storyId: "US-2", pullRequestNumber: 2, headSha: "merged-sha", validatedHeadSha: "merged-sha", state: "MERGED", checks: "PASS", checkedAt },
  ];
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog, githubConnected: true, githubObservations: observations });
  const result = await controller.sync(); assert.equal(result.connected, true); assert.equal(result.changedStoryIds.length, 2);
  const first = (await controller.story("US-1"))!; const second = (await controller.story("US-2"))!;
  assert.equal(first.validationStatus, "STALE"); assert.equal(first.externalStatus, "OPEN"); assert.equal(second.deliveryStatus, "MERGED");
  const closed = new LocalController(new AgentPersistence(join(root, ".agent-closed")), { backlogRoot: backlog, githubConnected: true, githubObservations: [{ ...observations[0], state: "CLOSED" }] });
  await closed.sync(); const closedStory = (await closed.story("US-1"))!; assert.equal(closedStory.deliveryStatus, "PR_OPEN"); assert.equal(closedStory.externalStatus, "CLOSED");
});

test("degrades without GitHub and keeps the last facts stale", async () => {
  const controller = new LocalController(new AgentPersistence(await mkdtemp(join(tmpdir(), "ai-factory-offline-"))));
  const result = await controller.sync(); assert.equal(result.connected, false); assert.equal(result.stale, true); assert.match(result.message, /unavailable/i);
  assert.equal((await controller.project()).github.stale, true);
});

test("projects the CLI orchestrator state into stories and executions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-external-state-")); const backlog = join(root, "backlog"); await mkdir(backlog);
  await writeFile(join(backlog, "US-01-landing.md"), "---\nstoryId: US-01\ngithubIssueNumber: 1\n---\n# US-01 — Landing\n\n## Objective\nBuild the landing.\n\n## Acceptance criteria\n- It works.\n", "utf8");
  const statePath = join(root, "automation", ".cache", "state.json"); await mkdir(join(root, "automation", ".cache"), { recursive: true });
  await writeFile(statePath, JSON.stringify({ stories: { "1": { issueNumber: 1, branch: "agent/issue-1", status: "IMPLEMENTING", updatedAt: new Date().toISOString() } } }), "utf8");
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog, orchestratorStatePath: statePath });
  const story = (await controller.listStories())[0]; const project = await controller.project(); const runs = await controller.runs();
  assert.equal(story.executionStatus, "ACTIVE"); assert.equal(story.agentStatus, "IMPLEMENTING"); assert.equal(story.branch, "agent/issue-1"); assert.equal(project.counts.active, 1); assert.equal(runs[0].storyId, "US-01"); assert.equal(runs[0].phase, "IMPLEMENTING");
});
