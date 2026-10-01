import { createHash, randomUUID } from "node:crypto";
import type { BacklogSyncAction, BacklogSyncPreview, StoryDetail } from "@ai-factory/contracts";

export interface IssueMirror { number: number; state: "open" | "closed"; title: string; body: string; labels: string[]; updatedAt?: string; }
export interface SyncBaselineEntry { issueNumber: number; localRevision: string; remoteRevision: string; }
export interface SyncBaseline { stories: Record<string, SyncBaselineEntry>; }

export function previewBacklogSync(stories: StoryDetail[], issues: IssueMirror[], baseline: SyncBaseline): BacklogSyncPreview {
  const actions = stories.map((story): BacklogSyncAction => {
    const previous = baseline.stories[story.storyId];
    const issue = issues.find((item) => issueStoryId(item) === story.storyId) || (previous ? issues.find((item) => item.number === previous.issueNumber) : undefined);
    if (!issue) return { storyId: story.storyId, kind: "CREATE", localRevision: story.specRevision };
    const remoteRevision = issueRevision(issue);
    const desiredRevision = issueRevision(desiredIssue(story, issue.number));
    if (remoteRevision === desiredRevision) return { storyId: story.storyId, kind: "UNCHANGED", issueNumber: issue.number, localRevision: story.specRevision, remoteRevision };
    if (!previous || previous.remoteRevision !== remoteRevision) return { storyId: story.storyId, kind: "CONFLICT", issueNumber: issue.number, localRevision: story.specRevision, remoteRevision, reason: previous ? "The GitHub Issue changed since the last confirmed sync." : "An existing Issue with this story marker differs and has no trusted sync baseline." };
    return { storyId: story.storyId, kind: "UPDATE", issueNumber: issue.number, localRevision: story.specRevision, remoteRevision };
  });
  return { previewId: randomUUID(), generatedAt: new Date().toISOString(), actions };
}

export function desiredIssue(story: StoryDetail, number = 0): IssueMirror {
  const content = stripFrontmatter(story.markdown);
  const body = [`<!-- ai-factory:story-id=${story.storyId} -->`, `<!-- ai-factory:local-revision=${story.specRevision} -->`, content].join("\n\n");
  return { number, state: "open", title: `[${story.storyId}] ${story.title}`, body, labels: [...(story.labels || [])].sort() };
}

export function issueStoryId(issue: Pick<IssueMirror, "body" | "title">): string | undefined {
  return issue.body.match(/<!--\s*ai-factory:story-id=([^\s>]+)\s*-->/i)?.[1]?.toUpperCase()
    || issue.body.match(/AI_FACTORY_STORY_ID:\s*([^\s<]+)/i)?.[1]?.toUpperCase()
    || issue.title.match(/^\[(US-\d{3,})\]/i)?.[1]?.toUpperCase();
}

export function issueRevision(issue: Pick<IssueMirror, "title" | "body" | "labels">): string {
  return createHash("sha256").update(JSON.stringify({ title: issue.title.trim(), body: issue.body.replace(/\r\n/g, "\n").trim(), labels: [...issue.labels].sort() })).digest("hex").slice(0, 16);
}

function stripFrontmatter(markdown: string): string { const normalized = markdown.replace(/\r\n/g, "\n"); if (!normalized.startsWith("---\n")) return normalized.trim(); const end = normalized.indexOf("\n---\n", 4); return end < 0 ? normalized.trim() : normalized.slice(end + 5).trim(); }
