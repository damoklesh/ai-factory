import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OrchestrationConfig } from "./types.js";

const defaults: Omit<OrchestrationConfig, "owner" | "repo"> = {
  targetRepository: "",
  targetBranch: "main",
  targetBacklogPath: "backlog",
  baseBranch: "main",
  runnerLabel: "ai-local",
  developerModel: "sol",
  developerReasoning: "medium",
  reviewerModel: "sol",
  reviewerReasoning: "medium",
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

export function loadConfig(filePath = process.env.AI_FACTORY_CONFIG || "config.json"): OrchestrationConfig {
  const source = JSON.parse(readFileSync(resolve(filePath), "utf8")) as Partial<OrchestrationConfig>;
  const targetRepository = source.targetRepository || (source.owner && source.repo ? `${source.owner}/${source.repo}` : "");
  if (!targetRepository || !/^\S+\/\S+$/.test(targetRepository)) throw new Error("config requires targetRepository in owner/repo format");
  const [owner, repo] = targetRepository.split("/", 2);
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
    developerModel: (source.developerModel || source.model || defaults.developerModel) as OrchestrationConfig["developerModel"],
    developerReasoning: source.developerReasoning || defaults.developerReasoning,
    reviewerModel: (source.reviewerModel || source.model || defaults.reviewerModel) as OrchestrationConfig["reviewerModel"],
    reviewerReasoning: source.reviewerReasoning || defaults.reviewerReasoning,
  };
  if (config.autoMerge !== false && config.autoMerge !== true) throw new Error("autoMerge must be boolean");
  if (!Array.isArray(config.allowedChangePaths) || config.allowedChangePaths.some((item) => typeof item !== "string" || !item.trim())) throw new Error("allowedChangePaths must be an array of non-empty strings");
  for (const [name, value] of [["developerModel", config.developerModel], ["reviewerModel", config.reviewerModel]] as const) if (!["luna", "sol", "terra"].includes(value)) throw new Error(`${name} must be luna, sol, or terra`);
  for (const [name, value] of [["developerReasoning", config.developerReasoning], ["reviewerReasoning", config.reviewerReasoning]] as const) if (!["low", "medium", "high"].includes(value)) throw new Error(`${name} must be low, medium, or high`);
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
