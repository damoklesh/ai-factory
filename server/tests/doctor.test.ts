import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScaffold, cancelScaffold, inspectProject, planScaffold } from "../src/doctor.js";

const execFileAsync = promisify(execFile);
const exists = (path: string) => access(path).then(() => true).catch(() => false);

test("detects Node, Java, Python, .NET, Go, mixed and unknown projects without mutation", async () => {
  const fixtures: Array<{ files: string[]; stack: string }> = [
    { files: ["package.json"], stack: "node" }, { files: ["pom.xml"], stack: "java" }, { files: ["pyproject.toml"], stack: "python" },
    { files: ["sample.csproj"], stack: "dotnet" }, { files: ["go.mod"], stack: "go" }, { files: ["package.json", "go.mod"], stack: "mixed" }, { files: [], stack: "unknown" },
  ];
  for (const fixture of fixtures) { const root = await mkdtemp(join(tmpdir(), "ai-factory-doctor-")); for (const file of fixture.files) await writeFile(join(root, file), file === "package.json" ? '{"scripts":{"test":"node --test","build":"tsc"}}' : "fixture"); const before = (await import("node:fs/promises")).readdir(root); const report = await inspectProject(root); assert.equal(report.stack, fixture.stack); assert.deepEqual((await before).sort(), (await (await import("node:fs/promises")).readdir(root)).sort()); if (fixture.stack === "node") assert.deepEqual(report.validationCommands, ["npm run build", "npm test"]); }
});

test("requires a confirmed stack and creates technology-specific scaffold only in an isolated worktree", async () => {
  for (const stack of ["java", "python"] as const) {
    const root = await mkdtemp(join(tmpdir(), `ai-factory-scaffold-${stack}-`)); const stateRoot = `${root}-state`; await execFileAsync("git", ["init", root], { windowsHide: true }); await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]); await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]); await writeFile(join(root, "seed.txt"), "seed\n"); await execFileAsync("git", ["-C", root, "add", "seed.txt"]); await execFileAsync("git", ["-C", root, "commit", "-m", "seed"], { windowsHide: true });
    const report = await inspectProject(root); assert.equal(report.stack, "unknown"); const plan = await planScaffold(root, stack); assert.ok(plan.files.some((file) => file.path === (stack === "java" ? "pom.xml" : "pyproject.toml"))); await assert.rejects(() => applyScaffold(root, stateRoot, plan, false), /CONFIRMATION/);
    const result = await applyScaffold(root, stateRoot, plan, true); assert.ok(await exists(join(result.worktreePath, stack === "java" ? "pom.xml" : "pyproject.toml"))); assert.equal(await exists(join(result.worktreePath, "package.json")), false); assert.equal(await exists(join(root, stack === "java" ? "pom.xml" : "pyproject.toml")), false); assert.ok(result.validation.every((item) => item.status === "SKIPPED"));
    await cancelScaffold(root, stateRoot); assert.equal(await exists(result.worktreePath), false);
  }
});
