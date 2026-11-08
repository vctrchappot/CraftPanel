import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appSettingsSchema, backupCreateSchema, badRequest, CRAFTPANEL_VERSION, scheduleSchema, SOFTWARE_INFO } from "@craftpanel/shared";
import { nextRuns, validateCron } from "@craftpanel/scheduler";
import { getProvider, log4shellMitigation, PROVIDERS } from "@craftpanel/minecraft-providers";
import { SETTING_GROUPS, SETTINGS } from "@craftpanel/config";
import { freeDiskSpace } from "@craftpanel/server-runtime";
import { dashboardUrls, isClientAllowed, isPrivateNetwork, lanAddresses, parseNetwork } from "@craftpanel/network";
import { isSecureRequest } from "../deployment";
import { deploymentDiagnostics } from "../diagnostics";
import { actorOf, canSee, noContent, requirePermission, requireUser, visibleServerIds, type AppContext } from "../context";
import { REDACTED } from "../services/settings";
import { isDiscordWebhook } from "../services/notifications";
import { parse } from "../validate";

// os.cpus() queries every core on each call (about 1 ms on Windows); the hardware doesn't change while we run.
let cpuCache: { cpus: number; cpuModel: string | null } | null = null;
const cpuInfo = () => (cpuCache ??= { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null });

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- backups ------------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string } }>("/api/backups", async (req) => {
    const me = requirePermission(req, "server.view", req.query.serverId || undefined);
    return (await ctx.backups.list(req.query.serverId)).filter((b) => canSee(me, b.serverId));
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
    requirePermission(req, "backup.create", (await ctx.backups.get(req.params.id)).serverId);
    return ctx.backups.verify(req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/backups/:id/restore", async (req, reply) => {
    requirePermission(req, "backup.restore", (await ctx.backups.get(req.params.id)).serverId);
    await ctx.backups.restore(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.delete<{ Params: { id: string } }>("/api/backups/:id", async (req, reply) => {
    requirePermission(req, "backup.delete", (await ctx.backups.get(req.params.id)).serverId);
    await ctx.backups.remove(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.get<{ Params: { id: string } }>("/api/backups/:id/download", async (req, reply) => {
    const row = await ctx.backups.get(req.params.id);
    requirePermission(req, "backup.restore", row.serverId);
    if (row.status !== "completed") throw badRequest("Backup is not complete");
    const file = await ctx.backups.filePath(row);
    const st = await fsp.stat(file);
    await ctx.activity.audit(actorOf(req), "backup.download", row.id);
    return reply.header("Content-Type", "application/zip").header("Content-Length", st.size).header("Content-Disposition", `attachment; filename="${row.filename}"`).send(fs.createReadStream(file));
  });

  // ---- schedules ------------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string } }>("/api/schedules", async (req) => {
    const me = requirePermission(req, "server.view", req.query.serverId || undefined);
    return (await ctx.schedules.list(req.query.serverId)).filter((x) => canSee(me, x.serverId));
  });
  app.post("/api/schedules", async (req) => {
    const input = parse(scheduleSchema, req.body);
    requirePermission(req, "schedule.manage", input.serverId ?? null);
    return ctx.schedules.create(input, actorOf(req));
  });
  app.put<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const input = parse(scheduleSchema, req.body);
    // Both the schedule's current server and the one it moves to must be manageable.
    requirePermission(req, "schedule.manage", await ctx.schedules.serverIdOf(req.params.id));
    requirePermission(req, "schedule.manage", input.serverId ?? null);
    return ctx.schedules.update(req.params.id, input, actorOf(req));
  });
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    requirePermission(req, "schedule.manage", await ctx.schedules.serverIdOf(req.params.id));
    await ctx.schedules.remove(req.params.id, actorOf(req));
    return noContent(reply);
  });
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req, reply) => {
    requirePermission(req, "schedule.manage", await ctx.schedules.serverIdOf(req.params.id));
    ctx.schedules.runNow(req.params.id, actorOf(req)).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });
  app.get<{ Params: { id: string } }>("/api/schedules/:id/runs", async (req) => {
    requirePermission(req, "server.view", await ctx.schedules.serverIdOf(req.params.id));
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
    return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, description: p.description, supportsPlugins: p.supportsPlugins, addons: SOFTWARE_INFO[p.id].addons }));
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
    return {
      builds: builds.slice(0, 30),
      java: { ...java, available: runtime ? { path: runtime.path, version: runtime.version, managed: runtime.managed } : null },
      log4shell: log4shellMitigation(version)?.description ?? null,
    };
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

  app.post("/api/system/stop-all", async (req) => {
    requirePermission(req, "app.configure");
    const results = await ctx.agent.stopAll();
    await ctx.activity.audit(actorOf(req), "runtime.stop_all", null, { results });
    await ctx.activity.event(null, "runtime.stop_all", "Maintenance: graceful stop requested for all servers", { actor: actorOf(req) });
    return { results };
  });

  app.get("/api/system", async (req) => {
    const me = requireUser(req);
    const disk = await freeDiskSpace(ctx.config.layout.root);
    const rows = (await ctx.servers.rows()).filter((r) => canSee(me, r.id));
    const running = rows.filter((r) => ctx.agent.isRunning(r.id));
    return {
      version: CRAFTPANEL_VERSION,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      node: process.version,
      ...cpuInfo(),
      loadAverage: process.platform === "win32" ? null : os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem() },
      allocatedMemoryMb: running.reduce((n, r) => n + r.memoryMb, 0),
      disk,
      dataDir: ctx.config.layout.root,
      uptimeSec: Math.round(process.uptime()),
      dashboard: {
        host: ctx.config.host,
        port: ctx.config.port,
        loopbackOnly: ctx.config.isLoopbackOnly,
        secureCookies: ctx.config.secureCookies,
        profile: ctx.config.profile,
        https: !!ctx.config.tls,
        behindProxy: ctx.config.trustProxy !== false,
        publicUrl: ctx.config.publicUrl,
        trustedProxies: ctx.config.trustProxy || [],
        transportSecure: isSecureRequest(req, ctx.config),
        urls: dashboardUrls(ctx.config.host, ctx.config.port, !!ctx.config.tls),
        clientIp: req.ip,
      },
      lan: lanAddresses().map((a) => a.address),
      servers: { total: rows.length, running: running.length },
    };
  });

  app.get("/api/system/diagnostics", async (req) => {
    requirePermission(req, "app.configure");
    return deploymentDiagnostics(ctx.config, { transportSecure: isSecureRequest(req, ctx.config) });
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/updates", async (req) => {
    requirePermission(req, "app.configure");
    return ctx.updates.status(req.query.refresh === "1");
  });
  /** One-click update: the installer's helper stops CraftPanel (servers save and stop), installs and starts the new version. */
  app.post("/api/updates/install", async (req, reply) => {
    requirePermission(req, "app.configure");
    const progress = await ctx.updates.startInstall();
    await ctx.activity.event(null, "craftpanel.update_started", `Updating CraftPanel from ${CRAFTPANEL_VERSION} to ${progress.target}`, { actor: actorOf(req) });
    await ctx.activity.audit(actorOf(req), "craftpanel.update", null, { from: CRAFTPANEL_VERSION, to: progress.target });
    return reply.code(202).send(progress);
  });
  app.get("/api/updates/progress", async (req) => {
    requirePermission(req, "app.configure");
    return ctx.updates.progress();
  });
  app.get("/api/updates/whats-new", async (req) => {
    requireUser(req);
    return ctx.updates.whatsNew();
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
    if (body.allowedNetworks) {
      const parsed = body.allowedNetworks.map((n) => ({ n, p: parseNetwork(n) }));
      const bad = parsed.filter((x) => !x.p).map((x) => x.n);
      if (bad.length) throw badRequest(`Not a valid IP address or CIDR range: ${bad.join(", ")}`, "Examples: 203.0.113.7, 198.51.100.0/24, 2001:db8::/48");
      body.allowedNetworks = [...new Set(parsed.map((x) => x.p!))];
    }
    if (body.dashboardAccess || body.allowedNetworks) {
      // Refuse changes that would immediately lock out the person making them.
      const current = await ctx.settings.get();
      const policy = body.dashboardAccess ?? current.dashboardAccess;
      const networks = body.allowedNetworks ?? current.allowedNetworks;
      if ((policy === "any" || networks.some((n) => !isPrivateNetwork(n))) &&
          (!ctx.config.secureCookies || !isSecureRequest(req, ctx.config)))
        throw badRequest("Public dashboard access requires HTTPS and Secure cookies", "Open the dashboard over HTTPS before allowing public addresses. Configure CRAFTPANEL_PUBLIC_URL and the trusted proxies, or built-in TLS.");
      if (!isClientAllowed(req.ip, policy, networks))
        throw badRequest(`This would block your own connection (${req.ip})`, "Add your address under additional networks, or make this change from the host itself.");
    }
    const patch: Record<string, unknown> = { ...body };
    if (body.ddnsToken === REDACTED) delete patch.ddnsToken;
    if (body.notifyDiscordWebhook === REDACTED) delete patch.notifyDiscordWebhook;
    else if (body.notifyDiscordWebhook && !isDiscordWebhook(body.notifyDiscordWebhook))
      throw badRequest("That is not a Discord webhook URL", "In Discord: Server settings → Integrations → Webhooks → Copy Webhook URL. It starts with https://discord.com/api/webhooks/.");
    if (body.notifyEmail?.password === REDACTED) patch.notifyEmail = { ...body.notifyEmail, password: (await ctx.settings.get()).notifyEmail.password };
    if (body.backupDirectory === "") patch.backupDirectory = null;
    await ctx.settings.set(patch);
    await ctx.schedules.configureDdns();
    await ctx.activity.audit(actorOf(req), "settings.update", null, {
      keys: Object.keys(patch),
      ...(body.dashboardAccess ? { dashboardAccess: body.dashboardAccess } : {}),
      ...(body.allowedNetworks ? { allowedNetworks: body.allowedNetworks } : {}),
    });
    return ctx.settings.publicView();
  });
  app.post("/api/settings/notifications/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    requirePermission(req, "app.configure");
    const results = await ctx.notifications.send({ title: "Test notification", message: "CraftPanel notifications work. You will get messages like this when a server crashes, a backup fails or an update is available.", level: "info" });
    if (!results.length) throw badRequest("No notification channel is set up", "Add a Discord webhook or turn on e-mail first, and save.");
    await ctx.activity.audit(actorOf(req), "settings.notifications_test", null, { results });
    return results;
  });
  app.post("/api/settings/ddns/test", async (req) => {
    requirePermission(req, "app.configure");
    return ctx.schedules.updateDdns();
  });

  // ---- activity & audit -----------------------------------------------------------------

  app.get<{ Querystring: { serverId?: string; limit?: string; before?: string } }>("/api/activity", async (req) => {
    const me = requirePermission(req, "server.view", req.query.serverId || undefined);
    return ctx.activity.list({
      serverId: req.query.serverId,
      onlyServers: visibleServerIds(me),
      limit: Number(req.query.limit ?? 100),
      before: req.query.before ? Number(req.query.before) : undefined,
    });
  });
  app.get("/api/audit", async (req) => {
    requirePermission(req, "audit.view");
    return ctx.activity.listAudit();
  });
}
