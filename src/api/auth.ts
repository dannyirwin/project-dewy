import type { MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";

/** No-op when token is unset — keeps offline tests working without env. */
export function bearerAuthWhenConfigured(token: string | undefined): MiddlewareHandler {
  const trimmed = token?.trim();
  if (!trimmed) {
    return async (_c, next) => next();
  }
  return bearerAuth({ token: trimmed });
}

const READ_ONLY_PREFIXES = ["/healthz", "/openapi.json", "/docs"];

function isReadOnlyPath(pathname: string, method: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  return READ_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Protect mutating HTTP routes when API_TOKEN is set. GET/HEAD stay public. */
export function apiWriteAuthMiddleware(apiToken: string | undefined): MiddlewareHandler {
  const trimmed = apiToken?.trim();
  if (!trimmed) {
    return async (_c, next) => next();
  }
  const check = bearerAuth({ token: trimmed });
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/mcp") return next();
    if (isReadOnlyPath(pathname, c.req.method)) return next();
    return check(c, next);
  };
}
