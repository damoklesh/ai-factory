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
      async updateIssue(number: number, input: { title: string; body: string }) { created[number - 1] = { ...created[number - 1], ...input }; return { number, ...created[number - 1], state: "open" as const }; },
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
    assert.deepEqual(second.updated, []);
    assert.equal(created.length, 1);
    assert.equal((await loadBacklog(root))[0].storyId, "US-001");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes Spanish backlog headings and P0 priority for the issue contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-backlog-es-"));
  try {
    await mkdir(join(directory, "backlog"));
    await writeFile(join(directory, "backlog", "US-01.md"), `# US-01 — Landing

**Prioridad:** P0. **Dependencias:** ninguna.

## User story
Como visitante quiero una landing.

## Criterios de aceptación

- La landing funciona.

## Validación técnica

Ejecutar npm test.
`);
    const created: Array<{ title: string; body: string; labels: string[] }> = [];
    const client = { async listIssues() { return []; }, async createIssue(input: { title: string; body: string; labels: string[] }) { created.push(input); return { number: 1, ...input, state: "open" as const }; }, async updateIssue() { throw new Error("not expected"); } } as unknown as GitHubClient;
    await syncBacklog(client, join(directory, "backlog"));
    assert.match(created[0].body, /## Objective/);
    assert.match(created[0].body, /## Acceptance criteria/);
    assert.match(created[0].body, /## Scope/);
    assert.match(created[0].body, /## Priority\n\n1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("translates backlog story dependencies into GitHub issue numbers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-backlog-deps-"));
  try {
    await writeFile(join(directory, "US-01.md"), "# First\n\n## User story\nFirst story.\n\n## Criterios de aceptación\n- First works.\n\n## Validación técnica\nRun tests.\n");
    await writeFile(join(directory, "US-02.md"), "# Second\n\n**Dependencias:** US-01.\n\n## User story\nSecond story.\n\n## Criterios de aceptación\n- Second works.\n\n## Validación técnica\nRun tests.\n");
    const created: Array<{ title: string; body: string; labels: string[] }> = [];
    const client = {
      async listIssues() { return []; },
      async createIssue(input: { title: string; body: string; labels: string[] }) { created.push(input); return { number: created.length, ...input, state: "open" as const }; },
      async updateIssue(number: number, input: { title: string; body: string }) { created[number - 1] = { ...created[number - 1], ...input }; return { number, ...created[number - 1], state: "open" as const }; },
    } as unknown as GitHubClient;
    await syncBacklog(client, directory);
    assert.match(created[1].body, /## Dependencies\n\n#1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
