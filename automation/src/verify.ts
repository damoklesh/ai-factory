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

export async function waitForRequiredChecks(client: GitHubClient, headSha: string, requiredChecks: string[], timeoutMs: number, pollMs = 5_000): Promise<{ checks: CheckRun[]; decision: "PASS" | "FAIL" }> {
  if (requiredChecks.length === 0) return { checks: [], decision: "PASS" };
  const deadline = Date.now() + timeoutMs;
  let checks: CheckRun[] = [];
  while (Date.now() <= deadline) {
    checks = await client.getChecks(headSha);
    const result = evaluateRequiredChecks(checks, requiredChecks, headSha);
    if (result.decision === "PASS") return { checks, decision: "PASS" };
    if (result.decision === "FAIL") return { checks, decision: "FAIL" };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  return { checks, decision: "FAIL" };
}
