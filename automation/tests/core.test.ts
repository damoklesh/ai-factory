import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRequiredChecks } from "../src/checks.js";
import { parseReviewResult, validateDeveloperResult } from "../src/result.js";
import { emptyState, loadState, saveState, transition } from "../src/state.js";
import { parseStory } from "../src/stories.js";
import { runProcess } from "../src/processes.js";
import { runValidation, runValidationPlan, validationsPassed } from "../src/verify.js";
import { CodexRunError, CodexRunner } from "../src/codex.js";
import type { Issue } from "../src/types.js";

const validIssue: Issue = {
  number: 20,
  title: "Valid story",
  state: "open",
  labels: ["agent:ready"],
  body: "## Objective\nAs a user I want a valid story.\n## Acceptance criteria\n- It works\n## Scope\nCore\n## Dependencies\nNone\n## Priority\n1\n## Validation\nnpm test",
};

test("parses and rejects malformed story contracts", () => {
  assert.equal(parseStory(validIssue).objective, "As a user I want a valid story.");
  assert.throws(() => parseStory({ ...validIssue, body: validIssue.body.replace("## Objective\nAs a user I want a valid story.", "## Objective") }), /missing Objective/);
  assert.throws(() => parseStory({ ...validIssue, body: validIssue.body.replace("None", "later") }), /invalid dependency/);
  assert.throws(() => parseStory({ ...validIssue, body: validIssue.body.replace("## Priority\n1", "## Priority\n0") }), /positive integer/);
});

test("covers all required check outcomes", () => {
  assert.equal(evaluateRequiredChecks([], ["CI"], "sha").decision, "WAIT");
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "queued", conclusion: null, headSha: "sha" }], ["CI"], "sha").decision, "WAIT");
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "completed", conclusion: "cancelled", headSha: "sha" }], ["CI"], "sha").decision, "FAIL");
  assert.equal(evaluateRequiredChecks([{ name: "CI", status: "completed", conclusion: "success", headSha: "sha" }], ["CI"], "sha").decision, "PASS");
});

test("persists state for restart and retains story metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-factory-state-test-"));
  const file = join(directory, "state.json");
  try {
    const state = emptyState();
    transition(state, 20, "FIXING", { fixCycles: 2, headSha: "abc", reason: "CI" });
    await saveState(file, state);
    const restored = await loadState(file);
    assert.equal(restored.stories["20"].fixCycles, 2);
    assert.equal(restored.stories["20"].headSha, "abc");
    assert.match(await readFile(file, "utf8"), /FIXING/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects extra malformed result shapes", () => {
  validateDeveloperResult({ summary: "done", tests: ["npm test"], risks: [] });
  assert.throws(() => validateDeveloperResult({ summary: "done", tests: [1], risks: [] }), /schema/);
  assert.throws(() => validateDeveloperResult({ summary: "done", tests: [], risks: [], extra: true }), /schema/);
  assert.throws(() => parseReviewResult({ decision: "UNKNOWN", findings: [], evidence: [] }), /schema/);
  assert.throws(() => parseReviewResult({ decision: "PASS", findings: [], evidence: [], extra: true }), /schema/);
  assert.deepEqual(parseReviewResult({ decision: "CHANGES_REQUESTED", findings: ["add a test"], evidence: ["failure"] }).findings, ["add a test"]);
});

test("executes Codex with schema output and classifies auth/quota failures", async () => {
  let outputPath = "";
  const fakeRunner = async (_command: string, args: string[], _options: { cwd: string; input?: string; timeoutMs: number }) => {
    outputPath = args[args.indexOf("-o") + 1];
    await writeFile(outputPath, JSON.stringify({ summary: "implemented", tests: ["npm test"], risks: [] }));
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
  const runner = new CodexRunner(process.cwd(), undefined, fakeRunner);
  assert.equal((await runner.developer("implement", process.cwd(), 1000)).summary, "implemented");
  await assert.rejects(() => access(outputPath), /ENOENT/);
  const authRunner = new CodexRunner(process.cwd(), undefined, async () => ({ code: 1, stdout: "", stderr: "login required", timedOut: false }));
  await assert.rejects(() => authRunner.developer("implement", process.cwd(), 1000), (error: CodexRunError) => error.kind === "AUTH");
  const quotaRunner = new CodexRunner(process.cwd(), undefined, async () => ({ code: 1, stdout: "", stderr: "rate limit reached", timedOut: false }));
  await assert.rejects(() => quotaRunner.reviewer("review", process.cwd(), 1000), (error: CodexRunError) => error.kind === "QUOTA");
});

test("runs deterministic validation commands and reports failures", async () => {
  const cwd = process.cwd();
  const pass = await runValidation(["node -e \"process.stdout.write('ok')\""], cwd, 5_000);
  assert.equal(validationsPassed(pass), true);
  assert.match(pass[0].output, /ok/);
  const fail = await runValidation(["node -e \"process.stderr.write('bad'); process.exit(2)\""], cwd, 5_000);
  assert.equal(validationsPassed(fail), false);
  assert.match(fail[0].output, /bad/);
});

test("runs configured smoke commands only after deterministic validation passes", async () => { const cwd = await mkdtemp(join(tmpdir(), "ai-factory-smoke-")); const plan = await runValidationPlan(["node -e \"process.stdout.write('unit')\""], ["node -e \"process.stdout.write('smoke')\""], cwd, 5_000); assert.equal(plan.validation[0].output, "unit"); assert.equal(plan.smoke[0].output, "smoke"); const failed = await runValidationPlan(["node -e \"process.exit(1)\""], ["node -e \"process.stdout.write('should-not-run')\""], cwd, 5_000); assert.equal(failed.smoke.length, 0); });

test("captures process failure and timeout without throwing", async () => {
  const failed = await runProcess(process.execPath, ["-e", "process.exit(3)"], { cwd: process.cwd(), timeoutMs: 5_000 });
  assert.equal(failed.code, 3);
  const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 20 });
  assert.equal(timedOut.timedOut, true);
});
