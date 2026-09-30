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

async function githubCheck(owner: string, repo: string, token: string): Promise<Check> {
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
    if (response.ok) return { name: "github-permissions", ok: true, detail: "repository readable; token value hidden" };
    return { name: "github-permissions", ok: false, detail: `GitHub returned HTTP ${response.status} (check repository access and token permissions)` };
  } catch (error) {
    return { name: "github-permissions", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [commandCheck("node", ["--version"]), commandCheck("npm", ["--version"]), commandCheck("git", ["--version"]), commandCheck("codex", ["--version"])];
  const configPath = process.env.AI_FACTORY_CONFIG || "config.json";
  let config: ReturnType<typeof loadConfig> | undefined;
  if (!existsSync(configPath)) checks.push({ name: "config", ok: false, detail: `${configPath} is absent; copy config.example.json and fill it locally` });
  else {
    try { config = loadConfig(configPath); checks.push({ name: "config", ok: true, detail: configPath }); }
    catch (error) { checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  const token = process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) checks.push({ name: "github-auth", ok: false, detail: "AGENT_GH_TOKEN/GITHUB_TOKEN is not set (value never printed)" });
  else if (config) checks.push(await githubCheck(config.owner, config.repo, token));
  else checks.push({ name: "github-permissions", ok: false, detail: "cannot check permissions until config is valid" });
  for (const check of checks) console.log(`${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}`);
  return checks.some((check) => !check.ok && ["node", "npm", "git", "codex"].includes(check.name)) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDoctor().then((code) => { process.exitCode = code; });
