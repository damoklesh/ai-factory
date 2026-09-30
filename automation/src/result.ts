import type { ReviewResult } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDeveloperResult(value: unknown): asserts value is { summary: string; tests: string[]; risks: string[] } {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.tests) || !Array.isArray(value.risks) || !value.tests.every((item) => typeof item === "string") || !value.risks.every((item) => typeof item === "string")) throw new Error("developer result does not match its schema");
}

export function parseReviewResult(value: unknown): ReviewResult {
  if (!isRecord(value) || !["PASS", "CHANGES_REQUESTED", "NEEDS_HUMAN"].includes(String(value.decision)) || !Array.isArray(value.findings) || !Array.isArray(value.evidence) || !value.findings.every((item) => typeof item === "string") || !value.evidence.every((item) => typeof item === "string")) throw new Error("review result does not match its schema");
  return { decision: value.decision as ReviewResult["decision"], findings: value.findings as string[], evidence: value.evidence as string[] };
}

