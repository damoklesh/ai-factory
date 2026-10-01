import type { CheckRun } from "./types.js";

/**
 * GitHub presents an Actions job in several equivalent forms depending on
 * which endpoint or UI is being used, for example `CI Gate`,
 * `CI / CI Gate (pull_request)`, or just the workflow/job display name.
 * Configuration stores the stable job name, so compare canonical forms.
 */
export function normalizeCheckName(value: string): string {
  const withoutEvent = value.trim().replace(/\s+\([^)]*\)\s*$/, "");
  const segments = withoutEvent.split(/\s+\/\s+/);
  return (segments.at(-1) || withoutEvent).trim().toLowerCase();
}

export function checkNameMatches(actual: string, required: string): boolean {
  return normalizeCheckName(actual) === normalizeCheckName(required);
}

export type CheckDecision = "PASS" | "WAIT" | "FAIL";

export function evaluateRequiredChecks(checks: CheckRun[], requiredNames: string[], headSha: string): { decision: CheckDecision; missing: string[]; failed: string[] } {
  if (requiredNames.length === 0) return { decision: "FAIL", missing: ["requiredChecks"], failed: [] };
  const current = checks.filter((check) => check.headSha === headSha);
  const missing = requiredNames.filter((name) => !current.some((check) => checkNameMatches(check.name, name)));
  const pending = current.filter((check) => requiredNames.some((name) => checkNameMatches(check.name, name)) && check.status !== "completed");
  const failed = current.filter((check) => requiredNames.some((name) => checkNameMatches(check.name, name)) && check.status === "completed" && check.conclusion !== "success").map((check) => check.name);
  if (failed.length > 0) return { decision: "FAIL", missing, failed };
  if (missing.length > 0 || pending.length > 0) return { decision: "WAIT", missing, failed };
  return { decision: "PASS", missing, failed };
}
