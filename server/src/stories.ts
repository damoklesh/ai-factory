import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { StoryDetail } from "@ai-factory/contracts";

export interface StorySource { storyId: string; title: string; markdown: string; revision: string; githubIssueNumber?: number; }

export async function loadRepositoryStories(root = resolve("backlog")): Promise<StoryDetail[]> {
  try {
    const names = (await readdir(root)).filter((name) => extname(name).toLowerCase() === ".md");
    const stories: StoryDetail[] = [];
    for (const name of names.sort()) stories.push(parseMarkdown(name, await readFile(join(root, name), "utf8")));
    return validateDependencies(stories);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function parseMarkdown(fileName: string, markdown: string): StoryDetail {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const storyId = frontmatter.storyId || basename(fileName, ".md");
  const title = frontmatter.title || firstHeading(body) || storyId;
  const criteria = sectionList(body, ["acceptance criteria", "criterios de aceptación", "criteria"]);
  const objective = sectionText(body, ["objective", "objetivo"]) || body.trim();
  const scope = sectionText(body, ["scope", "alcance"]);
  const validation = sectionList(body, ["validation", "validación", "tests"]);
  const revision = frontmatter.specRevision || createHash("sha256").update(markdown).digest("hex").slice(0, 12);
  return {
    storyId,
    title,
    priority: numberValue(frontmatter.priority, 99),
    dependencies: csv(frontmatter.dependencies),
    deliveryStatus: frontmatter.deliveryStatus as StoryDetail["deliveryStatus"] || "NOT_STARTED",
    executionStatus: "IDLE",
    validationStatus: "PENDING",
    specSource: "repository",
    specRevision: revision,
    githubIssueNumber: numberOptional(frontmatter.githubIssueNumber),
    pullRequestNumber: numberOptional(frontmatter.pullRequestNumber),
    headSha: frontmatter.headSha,
    updatedAt: new Date().toISOString(),
    objective,
    acceptanceCriteria: criteria,
    scope,
    validation,
    markdown: body,
    syncStatus: "LOCAL_ONLY",
  };
}

export function validateDependencies(stories: StoryDetail[]): StoryDetail[] {
  const ids = new Set(stories.map((story) => story.storyId));
  const graph = new Map(stories.map((story) => [story.storyId, story.dependencies]));
  return stories.map((story) => {
    const missing = story.dependencies.find((dependency) => !ids.has(dependency));
    const cycle = !missing && hasCycle(graph, story.storyId, new Set());
    return missing ? { ...story, dependencyError: `Missing dependency: ${missing}` } : cycle ? { ...story, dependencyError: "Cyclic dependency detected" } : story;
  });
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(3, end).split(/\r?\n/);
  const frontmatter: Record<string, string> = {};
  for (const line of raw) { const separator = line.indexOf(":"); if (separator > 0) frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""); }
  return { frontmatter, body: markdown.slice(end + 4).trim() };
}

function firstHeading(markdown: string): string | undefined { return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim(); }
function sectionText(markdown: string, names: string[]): string { const block = section(markdown, names); return block.replace(/^[-*]\s+/gm, "").trim(); }
function sectionList(markdown: string, names: string[]): string[] { return section(markdown, names).split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean); }
function section(markdown: string, names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => wanted.has(line.replace(/^##\s+/, "").trim().toLowerCase()));
  if (start < 0 || !lines[start].startsWith("##")) return "";
  const end = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : start + 1 + end).join("\n").trim();
}
function csv(value?: string): string[] { return (value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function numberValue(value: string | undefined, fallback: number): number { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function numberOptional(value?: string): number | undefined { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : undefined; }
function hasCycle(graph: Map<string, string[]>, node: string, path: Set<string>): boolean { if (path.has(node)) return true; path.add(node); for (const dependency of graph.get(node) || []) if (hasCycle(graph, dependency, new Set(path))) return true; return false; }
