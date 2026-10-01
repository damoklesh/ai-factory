import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OrchestrationConfig } from "./types.js";

const defaults: Omit<OrchestrationConfig, "owner" | "repo"> = {
  targetRepository: "",
  targetBranch: "main",
  targetBacklogPath: "backlog",
  baseBranch: "main",
  runnerLabel: "ai-local",
  modelVersion: "gpt-5.6",
  developerModel: "luna",
  developerReasoning: "xhigh",
  reviewerModel: "terra",
  reviewerReasoning: "high",
  validationCommands: [],
  smokeCommands: [],
  requiredChecks: [],
  timeouts: { codexMinutes: 45, ciMinutes: 20, workflowMinutes: 180 },
  maxStories: 1,
  maxFixCycles: 3,
  autoMerge: false,
  stateFile: ".cache/state.json",
  logDirectory: "logs",
  allowedChangePaths: [],
};

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

type ModelFamily = OrchestrationConfig["developerModel"];

/** Normalize the user-facing version to the base model ID expected by Codex. */
export function normalizeModelVersion(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const withoutRole = raw.replace(/-(?:luna|sol|terra)$/, "");
  const normalized = withoutRole.startsWith("gpt-") ? withoutRole : withoutRole ? `gpt-${withoutRole}` : "";
  if (!/^gpt-\d+(?:\.\d+)+$/.test(normalized)) throw new Error("modelVersion must use the gpt-X.Y format, for example gpt-5.6");
  return normalized;
}

/** Resolve a UI/configuration family such as `luna` into the full Codex model ID. */
export function resolveModelId(modelVersion: string, model: ModelFamily): string {
  return `${normalizeModelVersion(modelVersion)}-${model}`;
}

function legacyModelFamily(value: unknown): ModelFamily | undefined {
  if (value === "luna" || value === "sol" || value === "terra") return value;
  if (typeof value === "string") {
    const match = value.trim().match(/^gpt-\d+(?:\.\d+)+-(luna|sol|terra)$/);
    return match?.[1] as ModelFamily | undefined;
  }
  return undefined;
}

export function loadConfig(filePath = process.env.AI_FACTORY_CONFIG || "config.json"): OrchestrationConfig {
  const source = JSON.parse(readFileSync(resolve(filePath), "utf8")) as Partial<OrchestrationConfig>;
  const targetRepository = source.targetRepository || (source.owner && source.repo ? `${source.owner}/${source.repo}` : "");
  if (!targetRepository || !/^\S+\/\S+$/.test(targetRepository)) throw new Error("config requires targetRepository in owner/repo format");
  const [owner, repo] = targetRepository.split("/", 2);
  const legacyFamily = legacyModelFamily(source.model);
  const modelVersion = normalizeModelVersion(source.modelVersion || (legacyFamily ? defaults.modelVersion : source.model) || defaults.modelVersion);
  const config: OrchestrationConfig = {
    ...defaults,
    ...source,
    owner,
    repo,
    targetRepository,
    targetBranch: source.targetBranch || source.baseBranch || defaults.targetBranch,
    targetBacklogPath: source.targetBacklogPath || defaults.targetBacklogPath,
    baseBranch: source.targetBranch || source.baseBranch || defaults.baseBranch,
    timeouts: { ...defaults.timeouts, ...source.timeouts },
    modelVersion,
    developerModel: (source.developerModel || legacyFamily || defaults.developerModel) as OrchestrationConfig["developerModel"],
    developerReasoning: source.developerReasoning || defaults.developerReasoning,
    reviewerModel: (source.reviewerModel || legacyFamily || defaults.reviewerModel) as OrchestrationConfig["reviewerModel"],
    reviewerReasoning: source.reviewerReasoning || defaults.reviewerReasoning,
  };
  if (config.autoMerge !== false && config.autoMerge !== true) throw new Error("autoMerge must be boolean");
  if (!Array.isArray(config.allowedChangePaths) || config.allowedChangePaths.some((item) => typeof item !== "string" || !item.trim())) throw new Error("allowedChangePaths must be an array of non-empty strings");
  for (const [name, value] of [["developerModel", config.developerModel], ["reviewerModel", config.reviewerModel]] as const) if (!["luna", "sol", "terra"].includes(value)) throw new Error(`${name} must be luna, sol, or terra`);
  for (const [name, value] of [["developerReasoning", config.developerReasoning], ["reviewerReasoning", config.reviewerReasoning]] as const) if (!["low", "medium", "high", "xhigh"].includes(value)) throw new Error(`${name} must be low, medium, high, or xhigh`);
  positiveNumber(config.maxStories, "maxStories");
  positiveNumber(config.maxFixCycles, "maxFixCycles");
  positiveNumber(config.timeouts.codexMinutes, "timeouts.codexMinutes");
  positiveNumber(config.timeouts.ciMinutes, "timeouts.ciMinutes");
  positiveNumber(config.timeouts.workflowMinutes, "timeouts.workflowMinutes");
  return config;
}

export function targetWorkspacePath(config: OrchestrationConfig, controlRoot: string): string {
  return resolve(controlRoot, config.targetWorkspace || join("..", "workspaces", config.repo));
}
