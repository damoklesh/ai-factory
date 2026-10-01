import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubObservation, StoryDetail } from "@ai-factory/contracts";
import { desiredIssue, issueRevision, issueStoryId, previewBacklogSync, type IssueMirror } from "../src/backlog-sync.js";
import { parseMarkdown } from "../src/stories.js";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController, type GithubSyncAdapter } from "../src/controller.js";

function document(id = "US-001", title = "Publish backlog"): string { return `---\nstoryId: ${id}\ntitle: ${title}\npriority: 1\ndependencies: none\nlabels: agent:ready, product\n---\n# ${id} — ${title}\n\n## User Story\nAs a user, I want Issues so that collaboration is visible.\n\n## Scope\n- In scope: Issues\n\n## Acceptance Criteria\n- [ ] AC-1: Sync is idempotent.\n\n## Validation\n- [ ] Run tests.\n`; }
function parsed(id = "US-001", title = "Publish backlog"): StoryDetail { return parseMarkdown(`${id}.md`, document(id, title)); }

test("previews create, update, unchanged and conflict using stable story markers", () => {
  const story = parsed(); const desired = desiredIssue(story, 7);
  assert.equal(issueStoryId(desired), "US-001");
  assert.equal(previewBacklogSync([story], [], { stories: {} }).actions[0].kind, "CREATE");
  const baseline = { stories: { "US-001": { issueNumber: 7, localRevision: story.specRevision, remoteRevision: issueRevision(desired) } } };
  assert.equal(previewBacklogSync([story], [desired], baseline).actions[0].kind, "UNCHANGED");
  const changedLocal = parsed("US-001", "Publish changed backlog");
  assert.equal(previewBacklogSync([changedLocal], [desired], baseline).actions[0].kind, "UPDATE");
  const changedRemote = { ...desired, number: 99, title: "A human changed this title", body: `${desired.body}\nHuman edit` };
  const conflict = previewBacklogSync([changedLocal], [changedRemote], baseline).actions[0];
  assert.equal(conflict.kind, "CONFLICT");
  assert.equal(conflict.issueNumber, 99);
});

class FakeGithub implements GithubSyncAdapter {
  issues: IssueMirror[] = [];
  creates = 0; updates = 0;
  async observe(): Promise<GithubObservation[]> { return []; }
  async listIssues(): Promise<IssueMirror[]> { return this.issues.map((item) => ({ ...item, labels: [...item.labels] })); }
  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueMirror> { this.creates += 1; const issue = { number: this.creates, state: "open" as const, ...input }; this.issues.push(issue); return issue; }
  async updateIssue(number: number, input: { title: string; body: string; labels: string[] }): Promise<IssueMirror> { this.updates += 1; const issue = { number, state: "open" as const, ...input }; this.issues = this.issues.map((item) => item.number === number ? issue : item); return issue; }
}

test("publishes once, persists a secret-free baseline, and requires a choice for conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-publish-")); const backlog = join(root, "backlog"); await mkdir(backlog); await writeFile(join(backlog, "US-001.md"), document(), "utf8");
  const persistence = new AgentPersistence(join(root, ".agent")); const github = new FakeGithub(); const controller = new LocalController(persistence, { backlogRoot: backlog, githubAdapter: github });
  const firstPreview = await controller.previewBacklogSync(); assert.equal(firstPreview.actions[0].kind, "CREATE");
  const first = await controller.publishBacklog({ previewId: firstPreview.previewId, resolutions: [] }); assert.equal(first.created[0].issueNumber, 1); assert.equal(github.creates, 1);
  const secondPreview = await controller.previewBacklogSync(); assert.equal(secondPreview.actions[0].kind, "UNCHANGED");
  await controller.publishBacklog({ previewId: secondPreview.previewId, resolutions: [] }); assert.equal(github.creates, 1); assert.equal(github.updates, 0);
  github.issues[0] = { ...github.issues[0], body: `${github.issues[0].body}\nremote edit` };
  const conflictPreview = await controller.previewBacklogSync(); assert.equal(conflictPreview.actions[0].kind, "CONFLICT");
  const kept = await controller.publishBacklog({ previewId: conflictPreview.previewId, resolutions: [{ storyId: "US-001", decision: "KEEP_REMOTE" }] }); assert.equal(kept.conflicts.length, 1); assert.equal(github.updates, 0);
  const overwritePreview = await controller.previewBacklogSync();
  await controller.publishBacklog({ previewId: overwritePreview.previewId, resolutions: [{ storyId: "US-001", decision: "USE_LOCAL" }] }); assert.equal(github.updates, 1);
  const metadata = await readFile(join(root, ".agent", "backlog-sync.json"), "utf8"); assert.doesNotMatch(metadata, /token|secret|authorization/i);
});

test("records partial publish failures without leaking credential-like values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-publish-partial-")); const backlog = join(root, "backlog"); await mkdir(backlog);
  await writeFile(join(backlog, "US-001.md"), document("US-001", "First"), "utf8"); await writeFile(join(backlog, "US-002.md"), document("US-002", "Second"), "utf8");
  const github = new FakeGithub(); const originalCreate = github.createIssue.bind(github); github.createIssue = async (input) => { if (input.title.includes("US-002")) throw new Error("token=do-not-leak permission denied"); return originalCreate(input); };
  const controller = new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog, githubAdapter: github }); const preview = await controller.previewBacklogSync(); const result = await controller.publishBacklog({ previewId: preview.previewId, resolutions: [] });
  assert.equal(result.created.length, 1); assert.equal(result.failures.length, 1); assert.match(result.failures[0].message, /\[REDACTED\]/); assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
});
