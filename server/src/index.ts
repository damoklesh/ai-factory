import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./http.js";
import { githubToken, loadAppConfig } from "./config.js";
import { GitHubSyncAdapter } from "./github.js";
import { LocalController } from "./controller.js";

const port = Number(process.env.AI_FACTORY_UI_PORT || 3333);
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const uiDirectory = resolve(process.env.AI_FACTORY_UI_DIRECTORY || repositoryRoot, process.env.AI_FACTORY_UI_DIRECTORY ? "" : "ui/dist");
const config = loadAppConfig();
const token = githubToken();
const githubAdapter = token && config.owner !== "OWNER" && config.repo !== "REPO" ? new GitHubSyncAdapter(config.owner, config.repo, token) : undefined;
const targetWorkspace = resolve(repositoryRoot, config.targetWorkspace || join("..", "workspaces", config.repo));
const backlogRoot = resolve(targetWorkspace, config.targetBacklogPath || "backlog");
const orchestratorStatePath = resolve(repositoryRoot, "automation", config.stateFile || ".cache/state.json");
const controller = new LocalController(undefined, { githubAdapter, backlogRoot, orchestratorStatePath });
const app = createAppServer({ port, uiDirectory, controller });
app.server.listen(port, "127.0.0.1", () => {
  console.log(`AI Factory UI listening at http://127.0.0.1:${port}`);
  if (githubAdapter) void app.controller.sync();
});
if (githubAdapter) { const timer = setInterval(() => void app.controller.sync(), 15_000); timer.unref(); }
