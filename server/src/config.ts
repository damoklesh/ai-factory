import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfigView } from "@ai-factory/contracts";

const defaults: AppConfigView = {
  owner: "OWNER",
  repo: "REPO",
  baseBranch: "main",
  validationCommands: [],
  requiredChecks: [],
  maxStories: 1,
  maxFixCycles: 3,
  autoMerge: false,
  stateFile: ".agent/state.json",
  developerPrompt: "Keep changes small and focused.",
  reviewerPrompt: "Review the current commit and report evidence.",
};

export function configFilePath(configPath = process.env.AI_FACTORY_CONFIG || "automation/config.json"): string { return resolve(configPath); }

export function loadAppConfig(configPath?: string): AppConfigView {
  try {
    const source = JSON.parse(readFileSync(configFilePath(configPath), "utf8")) as Partial<AppConfigView>;
    return { ...defaults, ...source, validationCommands: source.validationCommands || [], requiredChecks: source.requiredChecks || [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
}

export function githubToken(): string | undefined {
  const token = process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN;
  return token?.trim() || undefined;
}
