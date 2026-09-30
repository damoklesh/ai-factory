import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";

export interface CliOptions {
  configPath: string;
  dryRun: boolean;
  mock: boolean;
  maxStories?: number;
  autoMerge?: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { configPath: process.env.AI_FACTORY_CONFIG || "config.json", dryRun: false, mock: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mock") options.mock = true;
    else if (arg === "--config") options.configPath = args[++index] || options.configPath;
    else if (arg === "--max-stories") options.maxStories = Number(args[++index]);
    else if (arg === "--auto-merge") options.autoMerge = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.maxStories !== undefined && (!Number.isInteger(options.maxStories) || options.maxStories < 1)) throw new Error("--max-stories must be a positive integer");
  return options;
}

export async function runOrchestrator(args: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (options.dryRun) {
    console.log("AI Factory dry-run: no GitHub, worktree, Codex, push, or merge operation will be performed.");
    if (!existsSync(options.configPath)) {
      console.log(`Config not found at ${options.configPath}; copy config.example.json for a configured run.`);
      return 0;
    }
    const config = loadConfig(options.configPath);
    console.log(`Repository: ${config.owner}/${config.repo}`);
    console.log(`Base branch: ${config.baseBranch}; max stories: ${options.maxStories ?? config.maxStories}; autoMerge: ${options.autoMerge ?? config.autoMerge}`);
    console.log(`Validation commands: ${config.validationCommands.length}; required checks: ${config.requiredChecks.length}`);
    return 0;
  }
  if (options.mock) {
    console.log("AI Factory mock mode is not yet connected to external services; no remote mutation was performed.");
    return 0;
  }
  throw new Error("A configured run is not available yet; use --dry-run or --mock while completing setup.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrchestrator().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

