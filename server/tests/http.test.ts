import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";
import { createAppServer } from "../src/http.js";

test("serves project data and protects all mutating routes", async () => {
  const port = 3417;
  const app = createAppServer({ port, controller: new LocalController(new AgentPersistence(join(await mkdtemp(join(tmpdir(), "ai-factory-http-")), ".agent"))) });
  await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    const project = await fetch(`${base}/api/project`);
    assert.equal(project.status, 200);
    const cookie = project.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ maxStories: 1, autoMerge: false }) })).status, 403);
    const started = await fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 1, autoMerge: false }) });
    assert.equal(started.status, 201);
    const run = await started.json() as { runId: string };
    const duplicate = await fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 1, autoMerge: false }) });
    assert.equal(duplicate.status, 409);
    const concurrent = await Promise.all([
      fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 1, autoMerge: false }) }),
      fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 1, autoMerge: false }) }),
    ]);
    assert.equal(concurrent.filter((response) => response.status === 409).length, 2);
    const badOrigin = await fetch(`${base}/api/runs/${run.runId}/pause`, { method: "POST", headers: { Cookie: cookie!, Origin: "http://evil.invalid" } });
    assert.equal(badOrigin.status, 403);
    const invalid = await fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 0, autoMerge: false }) });
    assert.equal(invalid.status, 400);
  } finally { await new Promise<void>((resolve) => app.server.close(() => resolve())); }
});

test("reports missing runner diagnostics without exposing credentials", async () => {
  const app = createAppServer({ port: 3418, controller: new LocalController(undefined, { codexAvailable: false }) });
  await new Promise<void>((resolve) => app.server.listen(3418, "127.0.0.1", resolve));
  try {
    const response = await fetch("http://127.0.0.1:3418/api/project");
    const project = await response.json() as { codex: { available: boolean; message?: string }; diagnostics?: Array<{ name: string; available: boolean }> };
    assert.equal(project.codex.available, false);
    assert.equal(project.diagnostics?.find((item) => item.name === "codex")?.available, false);
    assert.doesNotMatch(JSON.stringify(project), /TOKEN|PASSWORD|AUTH|SECRET/i);
  } finally { await new Promise<void>((resolve) => app.server.close(() => resolve())); }
});

test("exposes the story template and blocks start when the backlog is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-invalid-backlog-"));
  const backlog = join(root, "backlog"); await mkdir(backlog);
  await writeFile(join(backlog, "broken.md"), "# Missing frontmatter and required sections\n", "utf8");
  const port = 3419;
  const app = createAppServer({ port, controller: new LocalController(new AgentPersistence(join(root, ".agent")), { backlogRoot: backlog }) });
  await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    const templateResponse = await fetch(`${base}/api/stories/template`);
    const cookie = templateResponse.headers.get("set-cookie")?.split(";")[0];
    const validation = await templateResponse.json() as { valid: boolean; template: string; diagnostics: Array<{ file: string; line: number; code: string }> };
    assert.equal(validation.valid, false);
    assert.match(validation.template, /## Acceptance Criteria/);
    assert.ok(validation.diagnostics.some((item) => item.file === "broken.md" && item.line === 1));
    const started = await fetch(`${base}/api/runs`, { method: "POST", headers: { Cookie: cookie!, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ maxStories: 1, autoMerge: false }) });
    assert.equal(started.status, 400);
    assert.match((await started.json() as { message: string }).message, /BACKLOG_INVALID.*broken\.md:1/);
  } finally { await new Promise<void>((resolve) => app.server.close(() => resolve())); }
});
