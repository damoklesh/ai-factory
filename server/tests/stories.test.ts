import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryStories, parseMarkdown, validateDependencies } from "../src/stories.js";

test("loads repository stories and extracts criteria without interpreting HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-backlog-"));
  await writeFile(join(root, "US-002.md"), `---\nstoryId: US-002\ntitle: Search backlog\npriority: 2\ndependencies: US-001\ngithubIssueNumber: 12\n---\n# Search backlog\n\n## Objective\nFind stories.\n\n## Acceptance criteria\n- Search by title\n- <script>alert(1)</script> stays text\n`, "utf8");
  const stories = await loadRepositoryStories(root);
  assert.equal(stories[0].storyId, "US-002");
  assert.deepEqual(stories[0].acceptanceCriteria, ["Search by title", "<script>alert(1)</script> stays text"]);
  assert.equal(stories[0].githubIssueNumber, 12);
  assert.equal(stories[0].syncStatus, "LOCAL_ONLY");
});

test("reports missing and cyclic dependencies clearly", () => {
  const a = parseMarkdown("US-A.md", "---\nstoryId: US-A\ndependencies: US-MISSING\n---\n# A");
  const b = parseMarkdown("US-B.md", "---\nstoryId: US-B\ndependencies: US-C\n---\n# B");
  const c = parseMarkdown("US-C.md", "---\nstoryId: US-C\ndependencies: US-B\n---\n# C");
  const stories = validateDependencies([a, b, c]);
  assert.match(stories[0].dependencyError || "", /Missing dependency/);
  assert.match(stories[1].dependencyError || "", /Cyclic dependency/);
  assert.match(stories[2].dependencyError || "", /Cyclic dependency/);
});

test("an empty backlog is a valid readable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-empty-backlog-"));
  await mkdir(root, { recursive: true });
  assert.deepEqual(await loadRepositoryStories(root), []);
});
