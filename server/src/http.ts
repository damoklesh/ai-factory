import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseBacklogSyncRequest, parseConfigUpdateRequest, parseDecisionRequest, parseInitProjectRequest, parseInstructionRequest, parseSelectProjectRequest, parseSpecUpdateRequest, parseStartRunRequest, ContractValidationError } from "@ai-factory/contracts";
import { LocalController } from "./controller.js";
import { hasSession, mutationOriginAllowed, requestHostAllowed, writeSecurityHeaders, writeSessionCookie } from "./security.js";

const json = (response: ServerResponse, status: number, value: unknown): void => { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
async function body(request: IncomingMessage): Promise<unknown> { let text = ""; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : {}; }
function errorCode(error: unknown): { status: number; code: string; message: string } { const message = error instanceof Error ? error.message : String(error); const status = ["RUN_ALREADY_ACTIVE", "RUN_ALREADY_ACTIVE_FOR_PROJECT", "STALE_APPROVAL", "APPROVAL_ALREADY_DECIDED", "MERGE_CHECKS_NOT_PASSING", "VERSION_CONFLICT", "RUN_CONTEXT_CHANGED", "SPEC_EDIT_REQUIRES_PAUSE", "SYNC_PREVIEW_STALE"].includes(message) ? 409 : ["RUN_NOT_FOUND", "APPROVAL_NOT_FOUND", "STORY_NOT_FOUND", "SYNC_PREVIEW_NOT_FOUND"].includes(message) ? 404 : 400; return { status, code: message, message }; }

export function createAppServer(options: { controller?: LocalController; uiDirectory?: string; host?: string; port?: number } = {}) {
  const controller = options.controller || new LocalController();
  const host = options.host || "127.0.0.1";
  const port = options.port || 3333;
  const session = randomBytes(24).toString("hex");
  const origin = `http://${host}:${port}`;
  const server = createServer(async (request, response) => {
    writeSecurityHeaders(response);
    try {
      if (!requestHostAllowed(request, `${host}:${port}`)) return json(response, 403, { code: "PERMISSION_DENIED", message: "unexpected Host" });
      if (request.method === "GET" && pathIsApi(request.url)) writeSessionCookie(response, session);
      const url = new URL(request.url || "/", origin);
      const path = url.pathname;
      if (path === "/api/events" && request.method === "GET") {
        response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.write(": connected\n\n");
        const runId = url.searchParams.get("runId") || undefined; const requestedCursor = url.searchParams.get("cursor"); const cursor = Number(request.headers["last-event-id"] || requestedCursor || 0);
        for (const event of await controller.eventsSince(Number.isFinite(cursor) ? cursor : 0, runId)) response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        const unsubscribe = controller.subscribe((event) => { if (!runId || event.runId === runId) response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); }); request.on("close", unsubscribe); return;
      }
      if (request.method !== "GET" && (!hasSession(request, session) || !mutationOriginAllowed(request, origin))) return json(response, 403, { code: "AUTH_REQUIRED", message: "valid local session and same-origin request required" });
      if (request.method === "GET" && path === "/api/project") return json(response, 200, await controller.project());
      if (request.method === "GET" && path === "/api/projects") return json(response, 200, await controller.recentProjects());
      if (request.method === "GET" && path === "/api/stories") return json(response, 200, await controller.listStories({ search: url.searchParams.get("search") || undefined, status: url.searchParams.get("status") || undefined }));
      if (request.method === "GET" && path === "/api/stories/template") return json(response, 200, await controller.backlogValidation());
      if (request.method === "GET" && path.startsWith("/api/stories/")) { const story = await controller.story(decodeURIComponent(path.slice("/api/stories/".length))); return story ? json(response, 200, story) : json(response, 404, { code: "NOT_FOUND", message: "story not found" }); }
      if (request.method === "GET" && path === "/api/runs") return json(response, 200, await controller.runs());
      if (request.method === "GET" && path.startsWith("/api/runs/") && path.endsWith("/logs/export")) { const page = await controller.logs(decodeURIComponent(path.split("/")[3]), { limit: 500 }); response.setHeader("Content-Disposition", `attachment; filename="${decodeURIComponent(path.split("/")[3])}-logs.jsonl"`); response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8"); return response.end(page.entries.map((entry) => JSON.stringify(entry)).join("\n")); }
      if (request.method === "GET" && path.startsWith("/api/runs/") && path.endsWith("/logs")) return json(response, 200, await controller.logs(decodeURIComponent(path.split("/")[3]), { cursor: numberParam(url.searchParams.get("cursor")), limit: numberParam(url.searchParams.get("limit")), level: enumParam(url.searchParams.get("level"), ["INFO", "WARN", "ERROR"]), source: enumParam(url.searchParams.get("source"), ["controller", "orchestrator", "developer", "reviewer", "git", "github", "validation"]), search: url.searchParams.get("search") || undefined }));
      if (request.method === "GET" && path.startsWith("/api/runs/")) return json(response, 200, await controller.run(decodeURIComponent(path.slice("/api/runs/".length))) || { code: "NOT_FOUND", message: "run not found" });
      if (request.method === "GET" && path === "/api/approvals") return json(response, 200, await controller.approvals());
      if (request.method === "GET" && path === "/api/config") return json(response, 200, await controller.configView());
      if (request.method === "GET" && path === "/api/history") return json(response, 200, await controller.history());
      if (request.method === "POST" && path === "/api/runs") return json(response, 201, await controller.start(parseStartRunRequest(await body(request))));
      if (request.method === "POST" && path === "/api/projects/select") { const input = parseSelectProjectRequest(await body(request)); return json(response, 200, await controller.selectProject(input.targetPath)); }
      if (request.method === "POST" && path === "/api/projects/init") { const input = parseInitProjectRequest(await body(request)); return json(response, 200, await controller.initializeProject(input.targetPath, input.confirmationPath)); }
      if (request.method === "POST" && path === "/api/backlog/sync/preview") return json(response, 200, await controller.previewBacklogSync());
      if (request.method === "POST" && path === "/api/backlog/sync") return json(response, 200, await controller.publishBacklog(parseBacklogSyncRequest(await body(request))));
      const runAction = path.match(/^\/api\/runs\/([^/]+)\/(pause|stop|resume)$/);
      if (request.method === "POST" && runAction) return json(response, 200, await controller.control(decodeURIComponent(runAction[1]), runAction[2] as "pause" | "stop" | "resume"));
      if (request.method === "POST" && path.startsWith("/api/runs/") && path.endsWith("/instructions")) { const instruction = parseInstructionRequest(await body(request)); return json(response, 202, await controller.addInstruction(decodeURIComponent(path.split("/")[3]), instruction)); }
      if (request.method === "POST" && path === "/api/sync") return json(response, 200, await controller.sync());
      if (request.method === "POST" && path.startsWith("/api/approvals/") && path.endsWith("/decision")) { const decision = parseDecisionRequest(await body(request)); return json(response, 200, await controller.decideApproval(decodeURIComponent(path.split("/")[3]), decision)); }
      if (request.method === "PUT" && path.startsWith("/api/stories/") && path.endsWith("/spec")) return json(response, 200, await controller.updateStorySpec(decodeURIComponent(path.split("/")[3]), parseSpecUpdateRequest(await body(request))));
      if (request.method === "PUT" && path === "/api/config") return json(response, 200, await controller.updateConfig(parseConfigUpdateRequest(await body(request))));
      if (options.uiDirectory && request.method === "GET") {
        const relative = path === "/" ? "index.html" : path.replace(/^\//, "");
        const root = resolve(options.uiDirectory);
        const file = resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) return json(response, 403, { code: "PERMISSION_DENIED", message: "file path is outside the UI directory" });
        try { const content = await readFile(file); response.setHeader("Content-Type", contentType(file)); return response.end(content); }
        catch { return json(response, 404, { code: "NOT_FOUND", message: "asset not found" }); }
      }
      return json(response, 404, { code: "NOT_FOUND", message: "route not found" });
    } catch (error) { const failure = error instanceof ContractValidationError ? { status: 400, code: "VALIDATION_ERROR", message: error.message } : errorCode(error); return json(response, failure.status, { code: failure.code, message: failure.message }); }
  });
  return { server, controller, host, port };
}

function pathIsApi(pathname: string | undefined): boolean { return Boolean(pathname && (pathname === "/api" || pathname.startsWith("/api/"))); }
function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}
function numberParam(value: string | null): number | undefined { if (!value) return undefined; const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : undefined; }
function enumParam<T extends string>(value: string | null, values: readonly T[]): T | undefined { return value && values.includes(value as T) ? value as T : undefined; }
