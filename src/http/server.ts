import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DB } from "../db.ts";
import { AppError, unauthorized } from "../domain/errors.ts";
import { actorForToken, type Actor } from "../auth.ts";

export interface Ctx {
  db: DB;
  req: IncomingMessage;
  res: ServerResponse;
  actor: Actor | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  cookies: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  auth: "required" | "optional";
}

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, handler: Handler, auth: "required" | "optional" = "required") {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) + "$"
    );
    this.routes.push({ method, pattern, keys, handler, auth });
  }
  get(p: string, h: Handler, a: "required" | "optional" = "required") { this.add("GET", p, h, a); }
  post(p: string, h: Handler, a: "required" | "optional" = "required") { this.add("POST", p, h, a); }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 6_000_000) throw new AppError(413, "payload_too_large", "request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("application/json")) return JSON.parse(text);
  if (ct.includes("application/x-www-form-urlencoded")) {
    const o: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) o[k] = v;
    return o;
  }
  return text;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

export function createApp(db: DB, router: Router): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      const cookies = parseCookies(req.headers.cookie);
      const actor = actorForToken(db, cookies["vr_session"]);
      for (const r of router.routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        if (r.auth === "required" && !actor) throw unauthorized();
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const ctx: Ctx = { db, req, res, actor, params, query: url.searchParams, body, cookies };
        await r.handler(ctx);
        return;
      }
      sendJson(res, 404, { error: { code: "not_found", message: "no route" } });
    } catch (e) {
      if (e instanceof AppError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message, detail: e.detail ?? null } });
      } else if (e instanceof SyntaxError) {
        sendJson(res, 400, { error: { code: "bad_json", message: "malformed request body" } });
      } else {
        console.error("unhandled", e);
        sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
      }
    }
  });
}
