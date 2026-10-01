import type { Issue, StoryContract } from "./types.js";

const headings: Record<string, keyof StoryContract> = {
  objetivo: "objective",
  objective: "objective",
  "user story": "objective",
  "criterios de aceptación": "acceptanceCriteria",
  "criterios de aceptacion": "acceptanceCriteria",
  "acceptance criteria": "acceptanceCriteria",
  alcance: "scope",
  scope: "scope",
  dependencias: "dependencies",
  dependencies: "dependencies",
  prioridad: "priority",
  priority: "priority",
  validación: "validation",
  validacion: "validation",
  validation: "validation",
};

function sections(body: string): Map<keyof StoryContract, string[]> {
  const result = new Map<keyof StoryContract, string[]>();
  let current: keyof StoryContract | undefined;
  for (const rawLine of body.split(/\r?\n/)) {
    // GitHub issue forms emit ### headings, while the hand-written contract uses ##.
    const match = rawLine.match(/^#{2,}\s+(.+?)\s*$/);
    if (match) {
      current = headings[match[1].trim().toLowerCase()];
      continue;
    }
    if (current) result.set(current, [...(result.get(current) || []), rawLine]);
  }
  return result;
}

function content(lines: string[] | undefined): string[] {
  return (lines || []).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
}

function parseDependencies(value: string): number[] {
  const normalized = value.trim();
  if (!normalized || /^ninguna$|^none$/i.test(normalized)) return [];
  const parts = normalized.split(/[,\s]+/).filter(Boolean);
  const dependencies: number[] = [];
  for (const part of parts) {
    const match = part.match(/^#?(\d+)$/);
    if (!match) throw new Error(`invalid dependency '${part}'; use None or issue numbers such as #12`);
    dependencies.push(Number(match[1]));
  }
  return [...new Set(dependencies)];
}

export function parseStory(issue: Issue): StoryContract {
  const parsed = sections(issue.body || "");
  const objective = content(parsed.get("objective"))[0];
  const acceptanceCriteria = content(parsed.get("acceptanceCriteria"));
  const scope = content(parsed.get("scope")).join(" ");
  const dependencyText = content(parsed.get("dependencies")).join(" ");
  const priorityText = content(parsed.get("priority"))[0];
  const validation = content(parsed.get("validation"));
  if (!objective) throw new Error(`#${issue.number}: missing Objective`);
  if (acceptanceCriteria.length === 0) throw new Error(`#${issue.number}: missing acceptance criteria`);
  if (!scope) throw new Error(`#${issue.number}: missing Scope`);
  if (!priorityText || !/^\d+$/.test(priorityText) || Number(priorityText) < 1) throw new Error(`#${issue.number}: Priority must be a positive integer`);
  return { objective, acceptanceCriteria, scope, dependencies: parseDependencies(dependencyText), priority: Number(priorityText), validation };
}

export interface StorySelection {
  issue: Issue;
  contract: StoryContract;
}

/** Returns a stable, user-facing refusal reason for an explicitly requested story. */
export function storyEligibility(issue: Issue | undefined, issues: Issue[], completed: Set<number>): string | undefined {
  if (!issue) return "story not found";
  if (issue.state !== "open") return `story #${issue.number} is not open (${issue.state})`;
  if (completed.has(issue.number) || issue.labels.includes("agent:done")) return `story #${issue.number} is already merged/done`;
  if (issue.labels.includes("agent:blocked")) return `story #${issue.number} is blocked (agent:blocked)`;
  if (!issue.labels.includes("agent:ready")) return `story #${issue.number} is not marked agent:ready`;
  let contract: StoryContract;
  try { contract = parseStory(issue); } catch (error) { return error instanceof Error ? error.message : String(error); }
  const byNumber = new Map(issues.map((item) => [item.number, item]));
  for (const dependency of contract.dependencies) {
    if (!byNumber.has(dependency)) return `story #${issue.number} has missing dependency #${dependency}`;
    if (!completed.has(dependency) && !byNumber.get(dependency)?.labels.includes("agent:done")) return `story #${issue.number} has unmet dependency #${dependency}`;
  }
  return undefined;
}

export function validateDependencyGraph(issues: Issue[]): string[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const errors: string[] = [];
  const graph = new Map<number, number[]>();
  for (const issue of issues) {
    try {
      const contract = parseStory(issue);
      graph.set(issue.number, contract.dependencies);
      for (const dependency of contract.dependencies) if (!byNumber.has(dependency)) errors.push(`#${issue.number} depends on missing #${dependency}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (number: number, path: number[]): void => {
    if (visiting.has(number)) {
      const cycleStart = path.indexOf(number);
      errors.push(`dependency cycle: ${path.slice(cycleStart).map((item) => `#${item}`).join(" -> ")} -> #${number}`);
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number);
    for (const dependency of graph.get(number) || []) visit(dependency, [...path, number]);
    visiting.delete(number);
    visited.add(number);
  };
  for (const number of graph.keys()) visit(number, []);
  return [...new Set(errors)];
}

export function selectNextStory(issues: Issue[], completed: Set<number>): StorySelection | undefined {
  const graphErrors = validateDependencyGraph(issues);
  if (graphErrors.length > 0) return undefined;
  const candidates: StorySelection[] = [];
  for (const issue of issues) {
    if (completed.has(issue.number) || issue.state !== "open" || !issue.labels.includes("agent:ready")) continue;
    try {
      const contract = parseStory(issue);
      if (contract.dependencies.every((dependency) => completed.has(dependency))) candidates.push({ issue, contract });
    } catch {
      // Invalid stories are reported by validateDependencyGraph and never selected.
    }
  }
  candidates.sort((left, right) => left.contract.priority - right.contract.priority || left.issue.number - right.issue.number);
  return candidates[0];
}
