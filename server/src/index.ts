import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./http.js";
import { githubToken, loadAppConfig } from "./config.js";
import { GitHubSyncAdapter } from "./github.js";
import { LocalController } from "./controller.js";
import { AgentPersistence } from "./persistence.js";
import { ProjectWorkspaceStore } from "./projects.js";

const port = Number(process.env.AI_FACTORY_UI_PORT || 3333);
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const uiDirectory = resolve(process.env.AI_FACTORY_UI_DIRECTORY || repositoryRoot, process.env.AI_FACTORY_UI_DIRECTORY ? "" : "ui/dist");
const config = loadAppConfig();
const token = githubToken();
const orchestratorStatePath = resolve(repositoryRoot, "automation", config.stateFile || ".cache/state.json");
const projectStore = new ProjectWorkspaceStore(repositoryRoot, join(repositoryRoot, ".agent", "projects"), config.targetBacklogPath || "backlog");
const githubAdapterFactory = token ? (project: import("@ai-factory/contracts").TargetProject) => project.github ? new GitHubSyncAdapter(project.github.owner, project.github.repo, token) : undefined : undefined;
const controller = new LocalController(new AgentPersistence(join(repositoryRoot, ".agent", "projects", "unselected")), { githubAdapterFactory, projectStore, orchestratorStatePath });
const app = createAppServer({ port, uiDirectory, controller });
app.server.listen(port, "127.0.0.1", () => {
  console.log(`AI Factory UI listening at http://127.0.0.1:${port}`);
  if (token) void app.controller.sync().catch(() => undefined);
});
if (token) { const timer = setInterval(() => void app.controller.sync().catch(() => undefined), 15_000); timer.unref(); }
