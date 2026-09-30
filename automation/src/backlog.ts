import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { GitHubClient } from "./github.js";
import type { Issue } from "./types.js";

export interface BacklogStory {
  storyId: string;
  title: string;
  relativePath: string;
  body: string;
}

export interface BacklogSyncResult {
  created: Array<{ storyId: string; issueNumber?: number }>;
  existing: Array<{ storyId: string; issueNumber: number }>;
  updated: Array<{ storyId: string; issueNumber: number }>;
}

export async function loadBacklog(root: string): Promise<BacklogStory[]> {
  const directory = resolve(root);
  const names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".md")).sort();
  const stories = await Promise.all(names.map(async (name) => parseBacklogStory(name, await readFile(join(directory, name), "utf8"), directory)));
  const ids = new Set<string>();
  for (const story of stories) {
    if (ids.has(story.storyId)) throw new Error(`duplicate backlog story id: ${story.storyId}`);
    ids.add(story.storyId);
  }
  return stories;
}

export async function syncBacklog(client: GitHubClient, root: string, options: { dryRun?: boolean } = {}): Promise<BacklogSyncResult> {
  const stories = await loadBacklog(root);
  const issues = await client.listIssues();
  const result: BacklogSyncResult = { created: [], existing: [], updated: [] };
  for (const story of stories) {
    const existing = issues.find((issue) => storyIssueId(issue) === story.storyId);
    if (existing) {
      if (!options.dryRun && existing.body.includes(`AI_FACTORY_STORY_ID: ${story.storyId}`) && existing.body !== story.body) {
        await client.updateIssue(existing.number, { title: `[${story.storyId}] ${story.title}`, body: story.body });
        result.updated.push({ storyId: story.storyId, issueNumber: existing.number });
      } else result.existing.push({ storyId: story.storyId, issueNumber: existing.number });
      continue;
    }
    if (options.dryRun) { result.created.push({ storyId: story.storyId }); continue; }
    const issue = await client.createIssue({ title: `[${story.storyId}] ${story.title}`, body: story.body, labels: ["agent:ready"] });
    result.created.push({ storyId: story.storyId, issueNumber: issue.number });
  }
  return result;
}

export function backlogPath(targetRoot: string, configuredPath: string): string {
  const root = resolve(targetRoot);
  const path = resolve(root, configuredPath);
  const relativePath = relative(root, path);
  if (relativePath.startsWith("..") || relativePath === "") throw new Error("targetBacklogPath must point inside the target repository");
  return path;
}

export function storyIssueId(issue: Issue): string | undefined { return issue.body.match(/AI_FACTORY_STORY_ID:\s*([^\s<]+)/i)?.[1] || issue.title.match(/^\[([^\]]+)\]/)?.[1]; }

async function parseBacklogStory(fileName: string, markdown: string, root: string): Promise<BacklogStory> {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const storyId = frontmatter.storyId || basename(fileName, ".md");
  if (!/^[A-Za-z0-9._-]+$/.test(storyId)) throw new Error(`invalid backlog story id: ${storyId}`);
  const title = frontmatter.title || body.match(/^#\s+(.+)$/m)?.[1]?.replace(new RegExp(`^${storyId}\\s*[—-]\\s*`, "i"), "").trim() || storyId;
  const content = normalizeContent(body, frontmatter, title);
  const issueBody = [`<!-- AI_FACTORY_STORY_ID: ${storyId} -->`, `<!-- AI_FACTORY_SOURCE: ${relative(root, join(root, fileName)).replaceAll("\\", "/")} -->`, content].join("\n\n");
  return { storyId, title, relativePath: relative(root, join(root, fileName)).replaceAll("\\", "/"), body: issueBody };
}

function normalizeContent(body: string, frontmatter: Record<string, string>, title: string): string {
  if (/^##\s+Objective\s*$/im.test(body) && /^##\s+Acceptance criteria\s*$/im.test(body) && /^##\s+Scope\s*$/im.test(body) && /^##\s+Priority\s*$/im.test(body)) return body.trim();
  const objective = section(body, ["user story", "objective", "objetivo"]) || frontmatter.objective || title;
  const acceptance = section(body, ["acceptance criteria", "criterios de aceptación", "criterios de aceptaciÃ³n", "criterios de aceptacion"]);
  const scope = section(body, ["scope", "alcance", "contexto técnico necesario", "contexto tÃ©cnico necesario"]) || "Target repository application";
  const dependencies = frontmatter.dependencies || body.match(/dependencias:\s*([^\.\n]+)/i)?.[1]?.trim() || "None";
  const priorityRaw = frontmatter.priority || body.match(/prioridad:\s*P?(\d+)/i)?.[1] || "1";
  const priority = String(Math.max(1, Number(priorityRaw) + (/[Pp]\d+/.test(priorityRaw) ? 1 : 0)) || 1);
  const validation = section(body, ["validation", "validación técnica", "validaciÃ³n tÃ©cnica", "validacion tecnica"]) || "Use the configured validation commands.";
  return [`# ${title}`, "## Objective", objective, "## Acceptance criteria", acceptance ? acceptance.split(/\r?\n/).filter(Boolean).map((line) => line.match(/^\s*[-*]\s+/) ? line : `- ${line.trim()}`).join("\n") : "- Define the acceptance criteria in the backlog story.", "## Scope", scope.replace(/\r?\n/g, " "), "## Dependencies", dependencies, "## Priority", priority, "## Validation", validation].join("\n\n").trim();
}

function section(markdown: string, names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => wanted.has(line.replace(/^#{2,}\s+/, "").trim().toLowerCase()));
  if (start < 0) return "";
  const end = lines.slice(start + 1).findIndex((line) => /^#{2,}\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : start + 1 + end).join("\n").trim();
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const frontmatter: Record<string, string> = {};
  for (const line of markdown.slice(3, end).split(/\r?\n/)) { const separator = line.indexOf(":"); if (separator > 0) frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""); }
  return { frontmatter, body: markdown.slice(end + 4).trim() };
}
