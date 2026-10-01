import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKLOG_STORY_TEMPLATE, loadBacklog, loadRepositoryStories, parseMarkdown, validateDependencies } from "../src/stories.js";

function story(id: string, options: { title?: string; priority?: string; dependencies?: string; userStoryHeading?: string; criteria?: string } = {}): string {
  const title = options.title || `Story ${id}`;
  return `---\nstoryId: ${id}\ntitle: ${title}\npriority: ${options.priority || "1"}\ndependencies: ${options.dependencies || "none"}\n---\n\n# ${id} — ${title}\n\n## ${options.userStoryHeading || "User Story"}\nAs a user, I want ${title.toLowerCase()} so that it is useful.\n\n## Scope\n- In scope: ${title}\n- Out of scope: unrelated work\n\n## Acceptance Criteria\n${options.criteria || "- [ ] AC-1: It works without interpreting <script>alert(1)</script> as HTML."}\n\n## Validation\n- [ ] Run the documented tests.\n`;
}

test("parses the strict contract into a normalized model with a stable revision", () => {
  const markdown = story("US-002", { title: "Search backlog", priority: "2", dependencies: "US-001" });
  const first = parseMarkdown("US-002-search.md", markdown.replace(/\n/g, "\r\n"));
  const second = parseMarkdown("US-002-search.md", markdown);
  assert.equal(first.storyId, "US-002");
  assert.equal(first.priority, 2);
  assert.deepEqual(first.dependencies, ["US-001"]);
  assert.deepEqual(first.acceptanceCriteria, ["AC-1: It works without interpreting <script>alert(1)</script> as HTML."]);
  assert.equal(first.specRevision, second.specRevision);
  assert.equal(first.valid, true);
  assert.deepEqual(first.diagnostics, []);
});

test("reports required fields, priority, criteria and legacy headings with file and line", () => {
  const malformed = parseMarkdown("bad.md", `---\nstoryId: US-1\ntitle:\npriority: zero\ndependencies: none\nextra: value\n---\n# Bad\n\n## Objetivo\nLegacy text.\n\n## Scope\nScope.\n\n## Acceptance Criteria\n- It works\n\n## Validation\nRun tests.\n`);
  assert.equal(malformed.valid, false);
  assert.ok(malformed.diagnostics?.every((item) => item.file === "bad.md" && item.line > 0));
  assert.ok(malformed.diagnostics?.some((item) => item.code === "INVALID_STORY_ID"));
  assert.ok(malformed.diagnostics?.some((item) => item.code === "INVALID_PRIORITY"));
  assert.ok(malformed.diagnostics?.some((item) => item.code === "INVALID_ACCEPTANCE_CRITERION"));
  assert.ok(malformed.diagnostics?.some((item) => item.code === "DEPRECATED_HEADING" && item.severity === "WARNING"));
  assert.ok(malformed.diagnostics?.some((item) => item.code === "UNKNOWN_FRONTMATTER" && item.severity === "WARNING"));
});

test("reports missing, duplicate and cyclic dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-backlog-graph-"));
  await writeFile(join(root, "a.md"), story("US-001", { dependencies: "US-999" }));
  await writeFile(join(root, "b.md"), story("US-002", { dependencies: "US-003" }));
  await writeFile(join(root, "c.md"), story("US-003", { dependencies: "US-002" }));
  await writeFile(join(root, "duplicate-a.md"), story("US-004"));
  await writeFile(join(root, "duplicate-b.md"), story("US-004"));
  const backlog = await loadBacklog(root);
  assert.equal(backlog.stories.every((item) => item.valid === false), true);
  assert.ok(backlog.diagnostics.some((item) => item.code === "MISSING_DEPENDENCY"));
  assert.ok(backlog.diagnostics.some((item) => item.code === "CYCLIC_DEPENDENCY"));
  assert.equal(backlog.diagnostics.filter((item) => item.code === "DUPLICATE_STORY_ID").length, 2);
});

test("loads files deterministically and exposes the documented template", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-backlog-order-"));
  await writeFile(join(root, "z-last.md"), story("US-002"));
  await writeFile(join(root, "a-first.md"), story("US-001"));
  assert.deepEqual((await loadRepositoryStories(root)).map((item) => item.storyId), ["US-001", "US-002"]);
  assert.match(BACKLOG_STORY_TEMPLATE, /## User Story/);
  assert.match(BACKLOG_STORY_TEMPLATE, /AC-1:/);
});

test("validateDependencies remains usable for in-memory models", () => {
  const a = parseMarkdown("a.md", story("US-001", { dependencies: "US-999" }));
  validateDependencies([a]);
  assert.ok(a.diagnostics?.some((item) => item.code === "MISSING_DEPENDENCY"));
});

test("an empty backlog is a valid readable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-empty-backlog-"));
  await mkdir(root, { recursive: true });
  assert.deepEqual(await loadBacklog(root), { stories: [], diagnostics: [] });
});
