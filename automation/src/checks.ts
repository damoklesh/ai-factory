import type { CheckRun } from "./types.js";

export type CheckDecision = "PASS" | "WAIT" | "FAIL";

export function evaluateRequiredChecks(checks: CheckRun[], requiredNames: string[], headSha: string): { decision: CheckDecision; missing: string[]; failed: string[] } {
  if (requiredNames.length === 0) return { decision: "FAIL", missing: ["requiredChecks"], failed: [] };
  const current = checks.filter((check) => check.headSha === headSha);
  const missing = requiredNames.filter((name) => !current.some((check) => check.name === name));
  const pending = current.filter((check) => requiredNames.includes(check.name) && check.status !== "completed");
  const failed = current.filter((check) => requiredNames.includes(check.name) && check.status === "completed" && check.conclusion !== "success").map((check) => check.name);
  if (failed.length > 0) return { decision: "FAIL", missing, failed };
  if (missing.length > 0 || pending.length > 0) return { decision: "WAIT", missing, failed };
  return { decision: "PASS", missing, failed };
}
