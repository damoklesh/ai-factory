import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";

interface Check { name: string; ok: boolean; detail: string; }

function commandCheck(command: string, args: string[]): Check {
  const options = { encoding: "utf8" as const, timeout: 10_000, shell: process.platform === "win32" };
  let result = spawnSync(command, args, options);
  if (result.error && process.platform === "win32") result = spawnSync(`${command}.cmd`, args, options);
  if (result.error) return { name: command, ok: false, detail: result.error.message };
  return { name: command, ok: result.status === 0, detail: (result.stdout || result.stderr || "available").trim().split("\n")[0] };
}

export function runDoctor(): number {
  const checks: Check[] = [
    commandCheck("node", ["--version"]),
    commandCheck("npm", ["--version"]),
    commandCheck("git", ["--version"]),
    commandCheck("codex", ["--version"]),
  ];
  const configPath = process.env.AI_FACTORY_CONFIG || "config.json";
  if (!existsSync(configPath)) {
    checks.push({ name: "config", ok: false, detail: `${configPath} is absent; copy config.example.json and fill it locally` });
  } else {
    try {
      loadConfig(configPath);
      checks.push({ name: "config", ok: true, detail: configPath });
    } catch (error) {
      checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const hasToken = Boolean(process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN);
  checks.push({ name: "github-auth", ok: hasToken, detail: hasToken ? "token present (value hidden)" : "AGENT_GH_TOKEN/GITHUB_TOKEN is not set" });
  for (const check of checks) console.log(`${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}`);
  return checks.some((check) => !check.ok && check.name !== "config" && check.name !== "github-auth") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runDoctor();
