import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBacklog, syncBacklog } from "../src/backlog.js";
import type { GitHubClient } from "../src/github.js";

test("converts backlog stories to idempotent GitHub issues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-backlog-"));
  try {
    await mkdir(join(directory, "backlog"));
    await writeFile(join(directory, "backlog", "US-001.md"), `---\nstoryId: US-001\ntitle: Salary form\n---\n\n## Objective\nAs a user I want a salary form.\n\n## Acceptance criteria\n- It accepts a salary\n\n## Scope\nTarget app\n\n## Dependencies\nNone\n\n## Priority\n1\n\n## Validation\nnpm test\n`);
    const created: Array<{ title: string; body: string; labels: string[] }> = [];
    const client = {
      async listIssues() { return created.map((item, index) => ({ number: index + 1, title: item.title, body: item.body, labels: item.labels, state: "open" as const })); },
      async createIssue(input: { title: string; body: string; labels: string[] }) { created.push(input); return { number: created.length, ...input, state: "open" as const }; },
    } as unknown as GitHubClient;
    const root = join(directory, "backlog");
    const preview = await syncBacklog(client, root, { dryRun: true });
    assert.deepEqual(preview.created, [{ storyId: "US-001" }]);
    assert.equal(created.length, 0);
    const first = await syncBacklog(client, root);
    assert.deepEqual(first.created, [{ storyId: "US-001", issueNumber: 1 }]);
    assert.equal(created[0].labels[0], "agent:ready");
    assert.match(created[0].body, /AI_FACTORY_STORY_ID: US-001/);
    const second = await syncBacklog(client, root);
    assert.deepEqual(second.existing, [{ storyId: "US-001", issueNumber: 1 }]);
    assert.equal(created.length, 1);
    assert.equal((await loadBacklog(root))[0].storyId, "US-001");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
