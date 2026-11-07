import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { AppError } from "@craftpanel/shared";
import { PathError } from "@craftpanel/backup";
import { isClientAllowed } from "@craftpanel/network";
import { SESSION_COOKIE, safeEqual } from "./auth/sessions";
import type { AppContext } from "./context";
import { authRoutes } from "./routes/auth";
import { serverRoutes } from "./routes/servers";
import { fileRoutes } from "./routes/files";
import { systemRoutes } from "./routes/system";
import { wsRoutes, isAllowedOrigin } from "./routes/ws";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_EXEMPT = new Set(["/api/auth/login", "/api/auth/setup"]);

export interface BuildOptions {
  logger?: boolean | object;
  /**
   * Local control channel for installers: a token stored in the data directory (readable only by
   * the account running CraftPanel) allows a graceful shutdown from this machine. Windows has no
   * SIGTERM for other processes, so this is how an update stops CraftPanel and its servers cleanly.
   */
  control?: { token: string; shutdown: () => void };
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const tls = ctx.config.tls;
  const app = Fastify({
    logger: opts.logger ?? { level: ctx.config.logLevel },
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 6 * 1024 * 1024,
    ...(tls ? { https: { cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) } } : {}),
  }) as unknown as FastifyInstance;

  // Network access policy (Settings → Remote access). Runs before everything else, including
  // the dashboard files and WebSocket upgrades. The host itself is always allowed.
  const deniedLogged = new Map<string, number>();
  app.addHook("onRequest", async (req, reply) => {
    const { dashboardAccess, allowedNetworks } = await ctx.settings.get();
    if (isClientAllowed(req.ip, dashboardAccess, allowedNetworks)) return;
    const now = Date.now();
    if ((deniedLogged.get(req.ip) ?? 0) < now - 600_000) {
      deniedLogged.set(req.ip, now);
      if (deniedLogged.size > 1000) deniedLogged.clear();
      req.log.warn(`Blocked dashboard access from ${req.ip} (allowed: ${dashboardAccess === "local" ? "this computer only" : "private networks and VPNs"}). Change this in Settings → Remote access.`);
    }
    return reply.code(403).type("text/plain; charset=utf-8").send("CraftPanel: access from your network is not allowed. The owner can change this in Settings → Remote access.");
  });

  await app.register(cookie);
  // Development only (dashboard on another port). The plugin allows just GET/HEAD/POST unless told otherwise.
  if (ctx.config.corsOrigins.length) await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(multipart);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    req.user = await ctx.sessions.resolve(req.cookies[SESSION_COOKIE], { ip: req.ip });

    if (UNSAFE.has(req.method)) {
      // Defense in depth: reject cross-site requests by Origin, then require the CSRF token.
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin, req.headers.host, ctx.config.corsOrigins)) throw new AppError(403, "bad_origin", "Cross-origin request rejected");
      const path = req.url.split("?")[0];
      if (!CSRF_EXEMPT.has(path) && req.user) {
        const token = req.headers["x-csrf-token"];
        if (typeof token !== "string" || !safeEqual(token, req.user.csrfToken)) throw new AppError(403, "csrf", "Invalid or missing CSRF token. Reload the page.");
      }
    }
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, hint: err.hint, details: (err as AppError & { details?: unknown }).details } });
    }
    if (err instanceof PathError) return reply.code(400).send({ error: { code: "invalid_path", message: err.message } });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return reply.code(404).send({ error: { code: "not_found", message: "File or directory not found" } });
    if (code === "EEXIST") return reply.code(409).send({ error: { code: "conflict", message: "Already exists" } });
    if (code === "ENOSPC") return reply.code(507).send({ error: { code: "disk_full", message: "The disk is full", hint: "Free up space or move backups to another drive." } });
    if (code === "EACCES" || code === "EPERM") return reply.code(500).send({ error: { code: "permission_denied", message: "CraftPanel lacks filesystem permission for this operation" } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? "bad_request", message: err.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: err.message || "Internal error" } });
  });

  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await serverRoutes(api, ctx);
    await fileRoutes(api, ctx);
    await systemRoutes(api, ctx);
    await wsRoutes(api, ctx);
    api.get("/api/health", async () => ({ ok: true }));
    api.post("/api/control/shutdown", async (req, reply) => {
      // The socket address, not req.ip: a proxy header must never make a request look local.
      const token = req.headers["x-craftpanel-control"];
      const local = LOOPBACK_PEERS.has(req.socket.remoteAddress ?? "");
      if (!opts.control || !local || typeof token !== "string" || !safeEqual(token, opts.control.token)) throw new AppError(403, "forbidden", "Not allowed");
      req.log.info("Shutdown requested by a local installer or update");
      setImmediate(opts.control.shutdown);
      return reply.code(202).send({ ok: true });
    });
  });

  // Serve the exported dashboard (production). In development Next.js serves it.
  const webDir = ctx.config.webDir;
  if (webDir && fs.existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDir, prefix: "/", wildcard: true, index: ["index.html"], redirect: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
      return reply.code(404).type("text/html").sendFile("404.html");
    });
  }

  return app;
}
