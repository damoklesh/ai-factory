import type { IncomingMessage, ServerResponse } from "node:http";

export function requestHostAllowed(request: IncomingMessage, expectedHost: string): boolean {
  const host = request.headers.host;
  return host === expectedHost;
}

export function writeSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
}

export function writeSessionCookie(response: ServerResponse, session: string): void { response.setHeader("Set-Cookie", `ai_factory_session=${session}; HttpOnly; SameSite=Strict; Path=/`); }
export function hasSession(request: IncomingMessage, expected: string): boolean { return (request.headers.cookie || "").split(";").some((item) => item.trim() === `ai_factory_session=${expected}`); }

export function mutationOriginAllowed(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  return origin === expectedOrigin;
}
