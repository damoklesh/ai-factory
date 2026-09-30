import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchestrationConfig } from "./types.js";

const defaults: Omit<OrchestrationConfig, "owner" | "repo"> = {
  baseBranch: "main",
  runnerLabel: "ai-local",
  validationCommands: [],
  smokeCommands: [],
  requiredChecks: [],
  timeouts: { codexMinutes: 45, ciMinutes: 20, workflowMinutes: 180 },
  maxStories: 1,
  maxFixCycles: 3,
  autoMerge: false,
  stateFile: ".cache/state.json",
  logDirectory: "logs",
};

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function loadConfig(filePath = process.env.AI_FACTORY_CONFIG || "config.json"): OrchestrationConfig {
  const source = JSON.parse(readFileSync(resolve(filePath), "utf8")) as Partial<OrchestrationConfig>;
  if (!source.owner || !source.repo) throw new Error("config requires owner and repo");
  const config: OrchestrationConfig = {
    ...defaults,
    ...source,
    owner: source.owner,
    repo: source.repo,
    timeouts: { ...defaults.timeouts, ...source.timeouts },
  };
  if (config.autoMerge !== false && config.autoMerge !== true) throw new Error("autoMerge must be boolean");
  positiveNumber(config.maxStories, "maxStories");
  positiveNumber(config.maxFixCycles, "maxFixCycles");
  positiveNumber(config.timeouts.codexMinutes, "timeouts.codexMinutes");
  positiveNumber(config.timeouts.ciMinutes, "timeouts.ciMinutes");
  positiveNumber(config.timeouts.workflowMinutes, "timeouts.workflowMinutes");
  return config;
}
