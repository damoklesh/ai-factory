import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
