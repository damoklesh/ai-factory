import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfigView } from "@ai-factory/contracts";

const defaults: AppConfigView = {
  owner: "OWNER",
  repo: "REPO",
  baseBranch: "main",
  targetRepository: "OWNER/REPO",
  targetBranch: "main",
  targetBacklogPath: "backlog",
  modelVersion: "gpt-5.6",
  developerModel: "luna",
  developerReasoning: "xhigh",
  reviewerModel: "terra",
  reviewerReasoning: "high",
  validationCommands: [],
  requiredChecks: [],
  maxStories: 1,
  maxFixCycles: 3,
  maxValidationAttempts: 3,
  autoMerge: false,
  stateFile: ".agent/state.json",
  developerPrompt: "Keep changes small and focused.",
  reviewerPrompt: "Review the current commit and report evidence.",
};

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export function configFilePath(configPath = process.env.AI_FACTORY_CONFIG): string { return resolve(repositoryRoot, configPath || "automation/config.json"); }

function normalizeModelVersion(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = (raw.replace(/-(?:luna|sol|terra)$/, "").startsWith("gpt-") ? raw.replace(/-(?:luna|sol|terra)$/, "") : raw ? `gpt-${raw}` : "");
  if (!/^gpt-\d+(?:\.\d+)+$/.test(normalized)) throw new Error("modelVersion must use the gpt-X.Y format, for example gpt-5.6");
  return normalized;
}

export function loadAppConfig(configPath?: string): AppConfigView {
  try {
    const source = JSON.parse(readFileSync(configFilePath(configPath), "utf8")) as Partial<AppConfigView>;
    const targetRepository = source.targetRepository || (source.owner && source.repo ? `${source.owner}/${source.repo}` : defaults.targetRepository!);
    const [owner, repo] = targetRepository.split("/", 2);
    return { ...defaults, ...source, owner, repo, targetRepository, modelVersion: normalizeModelVersion(source.modelVersion || source.model || defaults.modelVersion), developerModel: source.developerModel || defaults.developerModel, developerReasoning: source.developerReasoning || defaults.developerReasoning, reviewerModel: source.reviewerModel || defaults.reviewerModel, reviewerReasoning: source.reviewerReasoning || defaults.reviewerReasoning, baseBranch: source.targetBranch || source.baseBranch || defaults.baseBranch, targetBranch: source.targetBranch || source.baseBranch || defaults.targetBranch, validationCommands: source.validationCommands || [], requiredChecks: source.requiredChecks || [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
}

export function githubToken(): string | undefined {
  const token = process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN;
  return token?.trim() || undefined;
}
