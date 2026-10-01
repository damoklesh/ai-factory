import { access } from "node:fs/promises";
import { join } from "node:path";
import type { CheckRun } from "./types.js";
import { evaluateRequiredChecks } from "./checks.js";
import { runShellCommand } from "./processes.js";
import type { GitHubClient } from "./github.js";

export interface VerificationResult { command: string; passed: boolean; output: string; }

export async function runValidation(commands: string[], cwd: string, timeoutMs: number): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const result = await runShellCommand(command, cwd, timeoutMs);
    results.push({ command, passed: result.code === 0 && !result.timedOut, output: `${result.stdout}${result.stderr}`.trim() });
    if (result.code !== 0 || result.timedOut) break;
  }
  return results;
}

export async function runValidationPlan(validationCommands: string[], smokeCommands: string[], cwd: string, timeoutMs: number): Promise<{ validation: VerificationResult[]; smoke: VerificationResult[] }> { const validation = await runValidation(validationCommands, cwd, timeoutMs); const smoke = validationsPassed(validation) ? await runValidation(smokeCommands, cwd, timeoutMs) : []; return { validation, smoke }; }

export function validationsPassed(results: VerificationResult[]): boolean { return results.every((result) => result.passed); }

/** Return the deterministic dependency bootstrap command for a clean worktree. */
export async function dependencyInstallCommand(cwd: string): Promise<string | undefined> {
  try { await access(join(cwd, "node_modules")); return undefined; } catch { /* clean worktree */ }
  for (const [file, command] of [
    ["package-lock.json", "npm ci"],
    ["npm-shrinkwrap.json", "npm ci"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["package.json", "npm install"],
  ] as const) {
    try { await access(join(cwd, file)); return command; } catch { /* try the next supported manifest */ }
  }
  return undefined;
}

export async function installDependencies(cwd: string, command: string, timeoutMs: number): Promise<void> {
  const result = await runShellCommand(command, cwd, timeoutMs);
  if (result.code !== 0 || result.timedOut) throw new Error(`dependency installation failed (${command}): ${`${result.stdout}${result.stderr}`.trim().slice(-4_000) || "no output"}`);
}

export type RequiredCheckWaitDecision = "PASS" | "FAILED" | "PENDING" | "MISSING" | "TIMEOUT";

export async function waitForRequiredChecks(client: GitHubClient, headSha: string, requiredChecks: string[], timeoutMs: number, pollMs = 5_000): Promise<{ checks: CheckRun[]; decision: RequiredCheckWaitDecision }> {
  // Bootstrap projects may not have a GitHub Actions workflow yet. Let the
  // reviewer inspect the PR in that mode, while evaluateMergeGate() keeps the
  // PR in READY_FOR_MERGE and prevents both manual and automatic merging.
  if (requiredChecks.length === 0) return { checks: [], decision: "PASS" };
  const deadline = Date.now() + timeoutMs;
  let checks: CheckRun[] = [];
  let sawPending = false;
  while (Date.now() <= deadline) {
    checks = await client.getChecks(headSha);
    const result = evaluateRequiredChecks(checks, requiredChecks, headSha);
    if (result.decision === "PASS") return { checks, decision: "PASS" };
    if (result.decision === "FAIL") return { checks, decision: "FAILED" };
    const current = checks.filter((check) => check.headSha === headSha);
    sawPending ||= current.some((check) => requiredChecks.some((name) => check.name === name) && check.status !== "completed");
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  const result = evaluateRequiredChecks(checks, requiredChecks, headSha);
  if (sawPending) return { checks, decision: "TIMEOUT" };
  return { checks, decision: result.missing.length ? "MISSING" : "PENDING" };
}
