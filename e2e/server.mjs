import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createAppServer } from "../server/dist/src/http.js";
import { LocalController } from "../server/dist/src/controller.js";
import { AgentPersistence } from "../server/dist/src/persistence.js";
import { ProjectWorkspaceStore } from "../server/dist/src/projects.js";

const execFileAsync = promisify(execFile); const fixture = await mkdtemp(join(tmpdir(), "ai-factory-e2e-")); const control = resolve("."); const target = join(fixture, "target"); await mkdir(join(target, "backlog"), { recursive: true });
await writeFile(join(target, "backlog", "US-001.md"), `---\nstoryId: US-001\ntitle: Browser flow\npriority: 1\ndependencies: none\ndeliveryStatus: NOT_STARTED\ngithubIssueNumber: 1\nlabels: agent:ready\n---\n# US-001 — Browser flow\n\n## User Story\nAs a user, I want an offline browser flow so that supervision is verified.\n\n## Scope\n- In scope: local fake execution.\n\n## Acceptance Criteria\n- [ ] AC-1: Progress is visible.\n\n## Validation\n- [ ] Run deterministic tests.\n`, "utf8");
await execFileAsync("git", ["init", target], { windowsHide: true }); await execFileAsync("git", ["-C", target, "remote", "add", "origin", "https://github.com/example/fake.git"], { windowsHide: true });
class FakeExecution { async start(context) { let resolve; const completion = new Promise((done) => { resolve = done; }); const emit = (source, phase, message, activity = "RUNNING") => context.onEvent?.({ source, phase, level: "INFO", message, activity }); setTimeout(() => emit("developer", "IMPLEMENTING", "fake implementer running"), 100); setTimeout(() => emit("github", "CI", "fake PR opened", "WAITING_FOR_CHECKS"), 220); setTimeout(() => emit("reviewer", "REVIEWING", "fake reviewer found one actionable finding"), 340); setTimeout(() => emit("developer", "FIXING", "fake fixer addressed finding"), 460); setTimeout(() => emit("validation", "REVALIDATING", "fake validation passed"), 580); setTimeout(() => emit("reviewer", "REVIEWING", "fake reviewer approved current SHA"), 680); setTimeout(() => { emit("github", "WAITING", "Awaiting human merge approval", "WAITING_FOR_INPUT"); resolve({ status: "BLOCKED", summary: "MERGE_PENDING_APPROVAL: awaiting human merge approval" }); }, 800); return { pid: 4242, completion }; } }
const store = new ProjectWorkspaceStore(control, join(fixture, "state")); const controller = new LocalController(new AgentPersistence(join(fixture, "unselected")), { projectStore: store, executionService: new FakeExecution(), githubConnected: true }); await controller.selectProject(target);
const { server } = createAppServer({ controller, uiDirectory: resolve("ui", "dist"), host: "127.0.0.1", port: 4173 }); server.listen(4173, "127.0.0.1", () => console.log("E2E server ready on 4173"));
