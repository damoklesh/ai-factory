import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { StoryDetail, StoryDiagnostic } from "@ai-factory/contracts";

export interface BacklogLoadResult { stories: StoryDetail[]; diagnostics: StoryDiagnostic[]; }

export const BACKLOG_STORY_TEMPLATE = `---
storyId: US-001
title: A short imperative title
priority: 1
dependencies: none
labels: agent:ready
---

# US-001 — A short imperative title

## User Story
As a user, I want a capability so that I receive a concrete benefit.

## Context
Describe relevant constraints and references.

## Scope
- In scope: ...
- Out of scope: ...

## Acceptance Criteria
- [ ] AC-1: Describe an observable outcome.

## Technical Notes
- Preserve the target repository's stack and conventions.

## Validation
- [ ] Run the repository's documented checks.

## Human Decisions
None
`;

const requiredFrontmatter = ["storyId", "title", "priority", "dependencies"] as const;
const knownFrontmatter = new Set(["storyId", "title", "priority", "dependencies", "labels", "githubIssueNumber", "pullRequestNumber", "headSha", "deliveryStatus"]);
const requiredSections = ["User Story", "Scope", "Acceptance Criteria", "Validation"] as const;
const legacyHeadings: Record<(typeof requiredSections)[number], string[]> = {
  "User Story": ["Objective", "Objetivo", "User story"],
  "Scope": ["Alcance", "Contexto tecnico necesario", "Contexto técnico necesario"],
  "Acceptance Criteria": ["Acceptance criteria", "Criteria", "Criterios de aceptación", "Criterios de aceptacion"],
  "Validation": ["Validación", "Validacion", "Validación técnica", "Validacion tecnica", "Tests"],
};

export async function loadBacklog(root = resolve("backlog")): Promise<BacklogLoadResult> {
  try {
    const names = (await readdir(root)).filter((name) => extname(name).toLowerCase() === ".md").sort((left, right) => left.localeCompare(right, "en"));
    const stories = names.map(() => undefined as unknown as StoryDetail);
    for (let index = 0; index < names.length; index += 1) stories[index] = parseMarkdown(names[index], await readFile(join(root, names[index]), "utf8"));
    validateDependencies(stories);
    validateDuplicateIds(stories);
    const diagnostics = stories.flatMap((story) => story.diagnostics || []).sort(compareDiagnostic);
    return { stories, diagnostics };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stories: [], diagnostics: [] };
    throw error;
  }
}

export async function loadRepositoryStories(root = resolve("backlog")): Promise<StoryDetail[]> {
  return (await loadBacklog(root)).stories;
}

export function parseMarkdown(fileName: string, markdown: string): StoryDetail {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const diagnostics: StoryDiagnostic[] = [];
  const parsed = splitFrontmatter(normalized);
  if (!parsed.present) diagnostics.push(diagnostic(fileName, 1, "FRONTMATTER_REQUIRED", "Frontmatter delimited by --- is required."));
  if (!parsed.closed) diagnostics.push(diagnostic(fileName, 1, "FRONTMATTER_UNCLOSED", "Frontmatter must end with a closing --- line."));
  for (const key of requiredFrontmatter) if (!parsed.values[key]?.trim()) diagnostics.push(diagnostic(fileName, parsed.startLine, "REQUIRED_FRONTMATTER", `Required frontmatter key '${key}' is missing.`));
  for (const [key, line] of parsed.lines) if (!knownFrontmatter.has(key)) diagnostics.push(diagnostic(fileName, line, "UNKNOWN_FRONTMATTER", `Unknown frontmatter key '${key}' will be ignored.`, "WARNING"));

  const rawId = parsed.values.storyId?.trim() || basename(fileName, ".md").toUpperCase();
  const storyId = rawId.toUpperCase();
  if (parsed.values.storyId && !/^US-\d{3,}$/.test(storyId)) diagnostics.push(diagnostic(fileName, parsed.lines.get("storyId") || 1, "INVALID_STORY_ID", "storyId must match US-### (for example US-001)."));
  const rawPriority = parsed.values.priority?.trim();
  const priority = Number(rawPriority);
  if (rawPriority && (!Number.isInteger(priority) || priority < 1)) diagnostics.push(diagnostic(fileName, parsed.lines.get("priority") || 1, "INVALID_PRIORITY", "priority must be a positive integer; 1 is highest."));
  const dependencies = parseDependencies(parsed.values.dependencies, fileName, parsed.lines.get("dependencies") || 1, diagnostics);
  const sections = parseSections(parsed.body, parsed.bodyStartLine);
  const content = new Map<string, string>();
  for (const required of requiredSections) {
    const exact = sections.find((section) => section.heading === required);
    const legacy = exact ? undefined : sections.find((section) => legacyHeadings[required].some((heading) => normalizeHeading(heading) === normalizeHeading(section.heading)));
    const selected = exact || legacy;
    if (!selected) diagnostics.push(diagnostic(fileName, parsed.bodyStartLine, "REQUIRED_SECTION", `Required section '## ${required}' is missing.`));
    else {
      content.set(required, selected.content.trim());
      if (legacy) diagnostics.push(diagnostic(fileName, legacy.line, "DEPRECATED_HEADING", `Heading '## ${legacy.heading}' is deprecated; use '## ${required}'.`, "WARNING"));
      if (!selected.content.trim()) diagnostics.push(diagnostic(fileName, selected.line, "EMPTY_SECTION", `Section '## ${required}' must not be empty.`));
    }
  }

  const acceptance = parseAcceptanceCriteria(content.get("Acceptance Criteria") || "", fileName, sections.find((section) => normalizeHeading(section.heading) === normalizeHeading("Acceptance Criteria") || legacyHeadings["Acceptance Criteria"].some((heading) => normalizeHeading(heading) === normalizeHeading(section.heading)))?.line || parsed.bodyStartLine, diagnostics);
  const validation = listItems(content.get("Validation") || "");
  if (content.has("Validation") && validation.length === 0) diagnostics.push(diagnostic(fileName, sectionLine(sections, "Validation", parsed.bodyStartLine), "VALIDATION_TASK_REQUIRED", "Validation must contain at least one task or command."));
  const title = parsed.values.title?.trim() || firstHeading(parsed.body)?.replace(/^US-\d{3,}\s*[—–-]\s*/i, "").trim() || storyId;
  const firstError = diagnostics.find((item) => item.severity === "ERROR");
  return {
    storyId,
    title,
    priority: Number.isInteger(priority) && priority > 0 ? priority : Number.MAX_SAFE_INTEGER,
    dependencies,
    deliveryStatus: validDeliveryStatus(parsed.values.deliveryStatus),
    executionStatus: "IDLE",
    validationStatus: "PENDING",
    specSource: "repository",
    specRevision: createHash("sha256").update(normalized).digest("hex").slice(0, 12),
    githubIssueNumber: positiveInteger(parsed.values.githubIssueNumber),
    pullRequestNumber: positiveInteger(parsed.values.pullRequestNumber),
    headSha: parsed.values.headSha,
    updatedAt: new Date().toISOString(),
    objective: content.get("User Story") || "",
    acceptanceCriteria: acceptance,
    scope: content.get("Scope") || "",
    validation,
    markdown: normalized,
    syncStatus: "LOCAL_ONLY",
    sourceFile: fileName,
    diagnostics,
    valid: !firstError,
    dependencyError: firstError?.message,
    labels: parseLabels(parsed.values.labels),
  };
}

export function validateDependencies(stories: StoryDetail[]): StoryDetail[] {
  const ids = new Set(stories.map((story) => story.storyId));
  const graph = new Map(stories.map((story) => [story.storyId, story.dependencies]));
  for (const story of stories) {
    for (const dependency of story.dependencies.filter((item) => !ids.has(item))) addError(story, "MISSING_DEPENDENCY", `Dependency '${dependency}' does not resolve to a backlog story.`);
    if (story.dependencies.every((item) => ids.has(item)) && hasCycle(graph, story.storyId, new Set())) addError(story, "CYCLIC_DEPENDENCY", `Dependency cycle includes '${story.storyId}'.`);
  }
  return stories;
}

function validateDuplicateIds(stories: StoryDetail[]): void {
  const groups = new Map<string, StoryDetail[]>();
  for (const story of stories) groups.set(story.storyId, [...(groups.get(story.storyId) || []), story]);
  for (const [storyId, duplicates] of groups) if (duplicates.length > 1) for (const story of duplicates) addError(story, "DUPLICATE_STORY_ID", `storyId '${storyId}' is duplicated in: ${duplicates.map((item) => item.sourceFile).join(", ")}.`);
}

function addError(story: StoryDetail, code: string, message: string): void {
  const item = diagnostic(story.sourceFile || `${story.storyId}.md`, 1, code, message);
  story.diagnostics = [...(story.diagnostics || []), item];
  story.valid = false;
  story.dependencyError ||= message;
}

function splitFrontmatter(markdown: string): { present: boolean; closed: boolean; values: Record<string, string>; lines: Map<string, number>; body: string; bodyStartLine: number; startLine: number } {
  const all = markdown.split("\n");
  if (all[0]?.trim() !== "---") return { present: false, closed: false, values: {}, lines: new Map(), body: markdown.trim(), bodyStartLine: 1, startLine: 1 };
  const end = all.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { present: true, closed: false, values: {}, lines: new Map(), body: "", bodyStartLine: all.length, startLine: 1 };
  const values: Record<string, string> = {};
  const lines = new Map<string, number>();
  for (let index = 1; index <= end; index += 1) {
    const line = all[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    values[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    lines.set(key, index + 1);
  }
  return { present: true, closed: true, values, lines, body: all.slice(end + 2).join("\n").trim(), bodyStartLine: end + 3, startLine: 2 };
}

function parseSections(markdown: string, offset: number): Array<{ heading: string; line: number; content: string }> {
  const lines = markdown.split("\n");
  const result: Array<{ heading: string; line: number; content: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    result.push({ heading: match[1].trim(), line: offset + index, content: lines.slice(index + 1, end).join("\n").trim() });
  }
  return result;
}

function parseAcceptanceCriteria(value: string, file: string, line: number, diagnostics: StoryDiagnostic[]): string[] {
  const criteria: string[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.split("\n").entries()) {
    if (!item.trim()) continue;
    const match = item.match(/^\s*-\s*\[[ xX]\]\s*(AC-\d+)\s*:\s*(.+)$/);
    if (!match) { diagnostics.push(diagnostic(file, line + index + 1, "INVALID_ACCEPTANCE_CRITERION", "Acceptance criteria must use '- [ ] AC-N: observable outcome'.")); continue; }
    if (ids.has(match[1].toUpperCase())) diagnostics.push(diagnostic(file, line + index + 1, "DUPLICATE_ACCEPTANCE_CRITERION", `Acceptance criterion '${match[1]}' is duplicated.`));
    ids.add(match[1].toUpperCase());
    criteria.push(`${match[1].toUpperCase()}: ${match[2].trim()}`);
  }
  if (criteria.length === 0) diagnostics.push(diagnostic(file, line, "ACCEPTANCE_CRITERION_REQUIRED", "At least one uniquely numbered AC-* criterion is required."));
  return criteria;
}

function parseDependencies(value: string | undefined, file: string, line: number, diagnostics: StoryDiagnostic[]): string[] {
  if (!value?.trim()) return [];
  if (value.trim().toLowerCase() === "none") return [];
  const result = value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  for (const dependency of result) if (!/^US-\d{3,}$/.test(dependency)) diagnostics.push(diagnostic(file, line, "INVALID_DEPENDENCY_ID", `Dependency '${dependency}' must match US-###.`));
  return [...new Set(result)];
}

function parseLabels(value?: string): string[] { return [...new Set((value || "").split(",").map((item) => item.trim()).filter(Boolean))]; }

function listItems(value: string): string[] { return value.split("\n").map((line) => line.replace(/^\s*-\s*(?:\[[ xX]\]\s*)?/, "").trim()).filter(Boolean); }
function firstHeading(markdown: string): string | undefined { return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim(); }
function normalizeHeading(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function sectionLine(sections: Array<{ heading: string; line: number }>, canonical: keyof typeof legacyHeadings, fallback: number): number { return sections.find((section) => normalizeHeading(section.heading) === normalizeHeading(canonical) || legacyHeadings[canonical].some((heading) => normalizeHeading(heading) === normalizeHeading(section.heading)))?.line || fallback; }
function positiveInteger(value?: string): number | undefined { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined; }
function validDeliveryStatus(value?: string): StoryDetail["deliveryStatus"] { return ["NOT_STARTED", "IMPLEMENTING", "PR_OPEN", "MERGED"].includes(value || "") ? value as StoryDetail["deliveryStatus"] : "NOT_STARTED"; }
function diagnostic(file: string, line: number, code: string, message: string, severity: StoryDiagnostic["severity"] = "ERROR"): StoryDiagnostic { return { severity, code, message, file, line }; }
function compareDiagnostic(left: StoryDiagnostic, right: StoryDiagnostic): number { return left.file.localeCompare(right.file, "en") || left.line - right.line || left.code.localeCompare(right.code, "en"); }
function hasCycle(graph: Map<string, string[]>, node: string, path: Set<string>): boolean { if (path.has(node)) return true; path.add(node); for (const dependency of graph.get(node) || []) if (graph.has(dependency) && hasCycle(graph, dependency, new Set(path))) return true; return false; }
