import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appSettingsSchema, backupCreateSchema, badRequest, scheduleSchema } from "@craftpanel/shared";
import { nextRuns, validateCron } from "@craftpanel/scheduler";
import { getProvider, PROVIDERS } from "@craftpanel/minecraft-providers";
import { SETTING_GROUPS, SETTINGS } from "@craftpanel/config";
import { freeDiskSpace } from "@craftpanel/server-runtime";
import { lanAddresses } from "@craftpanel/network";
import { actorOf, noContent, requirePermission, requireUser, type AppContext } from "../context";
import { parse } from "../validate";

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- backups ------------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string } }>("/api/backups", async (req) => {
    requirePermission(req, "server.view");
    return ctx.backups.list(req.query.serverId);
  });
  app.post<{ Params: { id: string } }>("/api/servers/:id/backups", async (req, reply) => {
    requirePermission(req, "backup.create");
    const body = parse(backupCreateSchema, req.body);
    await ctx.servers.row(req.params.id);
    // Run in the background; progress is pushed over the WebSocket.
    ctx.backups.create(req.params.id, "manual", actorOf(req), body.note).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });
  app.post<{ Params: { id: string } }>("/api/backups/:id/verify", async (req) => {
    requirePermission(req, "backup.create");
    return ctx.backups.verify(req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/backups/:id/restore", async (req, reply) => {
    requirePermission(req, "backup.restore");
    await ctx.backups.restore(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.delete<{ Params: { id: string } }>("/api/backups/:id", async (req, reply) => {
    requirePermission(req, "backup.delete");
    await ctx.backups.remove(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.get<{ Params: { id: string } }>("/api/backups/:id/download", async (req, reply) => {
    requirePermission(req, "backup.restore");
    const row = await ctx.backups.get(req.params.id);
    if (row.status !== "completed") throw badRequest("Backup is not complete");
    const file = await ctx.backups.filePath(row);
    const st = await fsp.stat(file);
    await ctx.activity.audit(actorOf(req), "backup.download", row.id);
    return reply.header("Content-Type", "application/zip").header("Content-Length", st.size).header("Content-Disposition", `attachment; filename="${row.filename}"`).send(fs.createReadStream(file));
  });

  // ---- schedules ------------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string } }>("/api/schedules", async (req) => {
    requirePermission(req, "server.view");
    return ctx.schedules.list(req.query.serverId);
  });
  app.post("/api/schedules", async (req) => {
    requirePermission(req, "schedule.manage");
    return ctx.schedules.create(parse(scheduleSchema, req.body), actorOf(req));
  });
  app.put<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    requirePermission(req, "schedule.manage");
    return ctx.schedules.update(req.params.id, parse(scheduleSchema, req.body), actorOf(req));
  });
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    requirePermission(req, "schedule.manage");
    await ctx.schedules.remove(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req, reply) => {
    requirePermission(req, "schedule.manage");
    ctx.schedules.runNow(req.params.id, actorOf(req)).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });
  app.get<{ Params: { id: string } }>("/api/schedules/:id/runs", async (req) => {
    requirePermission(req, "server.view");
    return ctx.schedules.runs(req.params.id);
  });
  app.get<{ Querystring: { cron?: string } }>("/api/schedules/preview", async (req) => {
    requireUser(req);
    const cron = String(req.query.cron ?? "");
    const error = validateCron(cron);
    return { error, next: error ? [] : nextRuns(cron, 5).map((d) => d.getTime()) };
  });

  // ---- catalog: software, versions, java -------------------------------------------

  app.get("/api/catalog/software", async (req) => {
    requireUser(req);
    return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, description: p.description, supportsPlugins: p.supportsPlugins }));
  });
  app.get<{ Params: { software: string } }>("/api/catalog/:software/versions", async (req) => {
    requireUser(req);
    return getProvider(req.params.software).listVersions();
  });
  app.get<{ Params: { software: string; version: string } }>("/api/catalog/:software/versions/:version", async (req) => {
    requireUser(req);
    const p = getProvider(req.params.software);
    const version = parse(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), req.params.version);
    const [builds, java] = await Promise.all([p.listBuilds(version), p.javaRequirement(version)]);
    const runtime = await ctx.java.findCompatible(java.major);
    return { builds: builds.slice(0, 30), java: { ...java, available: runtime ? { path: runtime.path, version: runtime.version, managed: runtime.managed } : null } };
  });
  app.get("/api/catalog/settings", async (req) => {
    requireUser(req);
    return { groups: SETTING_GROUPS, settings: SETTINGS };
  });

  app.get("/api/java", async (req) => {
    requirePermission(req, "server.view");
    return ctx.java.detect();
  });
  app.post("/api/java/install", async (req) => {
    requirePermission(req, "app.configure");
    const { major } = parse(z.object({ major: z.number().int().min(8).max(40) }), req.body);
    const info = await ctx.java.install(major);
    await ctx.activity.event(null, "java.installed", `Installed Java ${info.version} (${info.vendor ?? "unknown vendor"})`, { actor: actorOf(req) });
    return info;
  });

  // ---- system / host --------------------------------------------------------------

  app.get("/api/system", async (req) => {
    requireUser(req);
    const disk = await freeDiskSpace(ctx.config.layout.root);
    const rows = await ctx.servers.rows();
    const running = rows.filter((r) => ctx.agent.isRunning(r.id));
    return {
      version: "0.1.0",
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      node: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? null,
      loadAverage: process.platform === "win32" ? null : os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem() },
      allocatedMemoryMb: running.reduce((n, r) => n + r.memoryMb, 0),
      disk,
      dataDir: ctx.config.layout.root,
      uptimeSec: Math.round(process.uptime()),
      dashboard: { host: ctx.config.host, port: ctx.config.port, loopbackOnly: ctx.config.isLoopbackOnly, secureCookies: ctx.config.secureCookies },
      lan: lanAddresses().map((a) => a.address),
      servers: { total: rows.length, running: running.length },
    };
  });

  // ---- application settings ----------------------------------------------------------

  app.get("/api/settings", async (req) => {
    requirePermission(req, "app.configure");
    return ctx.settings.publicView();
  });
  app.put("/api/settings", async (req) => {
    requirePermission(req, "app.configure");
    const body = parse(appSettingsSchema, req.body);
    if (body.backupDirectory) {
      if (!path.isAbsolute(body.backupDirectory)) throw badRequest("Backup directory must be an absolute path");
      await fsp.mkdir(body.backupDirectory, { recursive: true });
      await fsp.access(body.backupDirectory, fs.constants.W_OK).catch(() => {
        throw badRequest("CraftPanel cannot write to that backup directory");
      });
    }
    const patch: Record<string, unknown> = { ...body };
    if (body.ddnsToken === "••••••••") delete patch.ddnsToken;
    if (body.backupDirectory === "") patch.backupDirectory = null;
    await ctx.settings.set(patch);
    await ctx.schedules.configureDdns();
    await ctx.activity.audit(actorOf(req), "settings.update", null, { keys: Object.keys(patch).filter((k) => k !== "ddnsToken") });
    return ctx.settings.publicView();
  });
  app.post("/api/settings/ddns/test", async (req) => {
    requirePermission(req, "app.configure");
    return ctx.schedules.updateDdns();
  });

  // ---- activity & audit -----------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string; limit?: string; before?: string } }>("/api/activity", async (req) => {
    requirePermission(req, "server.view");
    return ctx.activity.list({ serverId: req.query.serverId, limit: Number(req.query.limit ?? 100), before: req.query.before ? Number(req.query.before) : undefined });
  });
  app.get("/api/audit", async (req) => {
    requirePermission(req, "audit.view");
    return ctx.activity.listAudit();
  });
}
