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
  const result: BacklogSyncResult = { created: [], existing: [] };
  for (const story of stories) {
    const existing = issues.find((issue) => storyIssueId(issue) === story.storyId);
    if (existing) { result.existing.push({ storyId: story.storyId, issueNumber: existing.number }); continue; }
    if (options.dryRun) { result.created.push({ storyId: story.storyId }); continue; }
    const issue = await client.createIssue({ title: `[${story.storyId}] ${story.title}`, body: story.body, labels: ["agent:ready"] });
    result.created.push({ storyId: story.storyId, issueNumber: issue.number });
  }
  return result;
}

export function storyIssueId(issue: Issue): string | undefined { return issue.body.match(/AI_FACTORY_STORY_ID:\s*([^\s<]+)/i)?.[1] || issue.title.match(/^\[([^\]]+)\]/)?.[1]; }

async function parseBacklogStory(fileName: string, markdown: string, root: string): Promise<BacklogStory> {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const storyId = frontmatter.storyId || basename(fileName, ".md");
  if (!/^[A-Za-z0-9._-]+$/.test(storyId)) throw new Error(`invalid backlog story id: ${storyId}`);
  const title = frontmatter.title || body.match(/^#\s+(.+)$/m)?.[1]?.trim() || storyId;
  const content = body.trim() || `## Objective\n${frontmatter.objective || title}\n\n## Acceptance criteria\n- Define the acceptance criteria in the backlog story.\n\n## Scope\nTarget repository\n\n## Dependencies\nNone\n\n## Priority\n${frontmatter.priority || "1"}\n\n## Validation\nUse the configured validation commands.`;
  const issueBody = [`<!-- AI_FACTORY_STORY_ID: ${storyId} -->`, `<!-- AI_FACTORY_SOURCE: ${relative(root, join(root, fileName)).replaceAll("\\", "/")} -->`, content].join("\n\n");
  return { storyId, title, relativePath: relative(root, join(root, fileName)).replaceAll("\\", "/"), body: issueBody };
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const frontmatter: Record<string, string> = {};
  for (const line of markdown.slice(3, end).split(/\r?\n/)) { const separator = line.indexOf(":"); if (separator > 0) frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""); }
  return { frontmatter, body: markdown.slice(end + 4).trim() };
}
