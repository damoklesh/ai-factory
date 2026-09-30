import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./http.js";

const port = Number(process.env.AI_FACTORY_UI_PORT || 3333);
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const uiDirectory = resolve(process.env.AI_FACTORY_UI_DIRECTORY || repositoryRoot, process.env.AI_FACTORY_UI_DIRECTORY ? "" : "ui/dist");
const app = createAppServer({ port, uiDirectory });
app.server.listen(port, "127.0.0.1", () => console.log(`AI Factory UI listening at http://127.0.0.1:${port}`));
