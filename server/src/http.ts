import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseDecisionRequest, parseInstructionRequest, parseStartRunRequest, ContractValidationError } from "@ai-factory/contracts";
import { LocalController } from "./controller.js";
import { hasSession, mutationOriginAllowed, requestHostAllowed, writeSecurityHeaders, writeSessionCookie } from "./security.js";

const json = (response: ServerResponse, status: number, value: unknown): void => { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
async function body(request: IncomingMessage): Promise<unknown> { let text = ""; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : {}; }
function errorCode(error: unknown): { status: number; code: string; message: string } { const message = error instanceof Error ? error.message : String(error); const status = message === "RUN_ALREADY_ACTIVE" ? 409 : message === "RUN_NOT_FOUND" ? 404 : 400; return { status, code: message, message }; }

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
        response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.write(": connected\n\n"); const unsubscribe = controller.subscribe((event) => response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)); request.on("close", unsubscribe); return;
      }
      if (request.method !== "GET" && (!hasSession(request, session) || !mutationOriginAllowed(request, origin))) return json(response, 403, { code: "AUTH_REQUIRED", message: "valid local session and same-origin request required" });
      if (request.method === "GET" && path === "/api/project") return json(response, 200, await controller.project());
      if (request.method === "GET" && path === "/api/stories") return json(response, 200, await controller.listStories());
      if (request.method === "GET" && path.startsWith("/api/stories/")) return json(response, 200, await controller.story(decodeURIComponent(path.slice("/api/stories/".length))) || { code: "NOT_FOUND", message: "story not found" });
      if (request.method === "GET" && path === "/api/runs") return json(response, 200, await controller.runs());
      if (request.method === "GET" && path.startsWith("/api/runs/") && path.endsWith("/logs")) return json(response, 200, await controller.logs(decodeURIComponent(path.split("/")[3])));
      if (request.method === "GET" && path.startsWith("/api/runs/")) return json(response, 200, await controller.run(decodeURIComponent(path.slice("/api/runs/".length))) || { code: "NOT_FOUND", message: "run not found" });
      if (request.method === "GET" && path === "/api/approvals") return json(response, 200, await controller.approvals());
      if (request.method === "GET" && path === "/api/config") return json(response, 200, await controller.configView());
      if (request.method === "POST" && path === "/api/runs") return json(response, 201, await controller.start(parseStartRunRequest(await body(request))));
      const runAction = path.match(/^\/api\/runs\/([^/]+)\/(pause|stop|resume)$/);
      if (request.method === "POST" && runAction) return json(response, 200, await controller.control(decodeURIComponent(runAction[1]), runAction[2] as "pause" | "stop" | "resume"));
      if (request.method === "POST" && path.startsWith("/api/runs/") && path.endsWith("/instructions")) { parseInstructionRequest(await body(request)); return json(response, 202, { accepted: true }); }
      if (request.method === "POST" && path === "/api/sync") return json(response, 200, { accepted: true, syncedAt: new Date().toISOString() });
      if (request.method === "POST" && path.startsWith("/api/approvals/") && path.endsWith("/decision")) { parseDecisionRequest(await body(request)); return json(response, 202, { accepted: true }); }
      if (request.method === "PUT" && path.startsWith("/api/stories/") && path.endsWith("/spec")) return json(response, 202, { accepted: true, message: "specification adapter pending" });
      if (request.method === "PUT" && path === "/api/config") return json(response, 202, { accepted: true, message: "configuration adapter pending" });
      if (options.uiDirectory && request.method === "GET") {
        const relative = path === "/" ? "index.html" : path.replace(/^\//, "");
        const root = resolve(options.uiDirectory);
        const file = resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) return json(response, 403, { code: "PERMISSION_DENIED", message: "file path is outside the UI directory" });
        try { const content = await readFile(file); response.setHeader("Content-Type", extname(file) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream"); return response.end(content); }
        catch { return json(response, 404, { code: "NOT_FOUND", message: "asset not found" }); }
      }
      return json(response, 404, { code: "NOT_FOUND", message: "route not found" });
    } catch (error) { const failure = error instanceof ContractValidationError ? { status: 400, code: "VALIDATION_ERROR", message: error.message } : errorCode(error); return json(response, failure.status, { code: failure.code, message: failure.message }); }
  });
  return { server, controller, host, port };
}

function pathIsApi(pathname: string | undefined): boolean { return Boolean(pathname && (pathname === "/api" || pathname.startsWith("/api/"))); }
