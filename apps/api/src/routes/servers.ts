import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AppError,
  badRequest,
  commandSchema,
  createServerSchema,
  gameruleUpdateSchema,
  ipBanSchema,
  levelNameSchema,
  playerActionSchema,
  portSchema,
  propertiesUpdateSchema,
  updateServerSchema,
  worldCreateSchema,
} from "@craftpanel/shared";
import { eq, servers as serversTable } from "@craftpanel/database";
import { directorySize, freeDiskSpace } from "@craftpanel/server-runtime";
import { diagnoseWan, formatAddress, lanAddresses, fetchPublicIp, isPrivateIPv4 } from "@craftpanel/network";
import { getProvider, searchModrinthPlugins, compatibleModrinthVersions } from "@craftpanel/minecraft-providers";
import { actorOf, noContent, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";

type IdParams = { Params: { id: string } };

/** Stream a multipart upload to a temporary file. */
export async function receiveUpload(ctx: AppContext, req: FastifyRequest, maxBytes: number): Promise<{ file: string; filename: string; cleanup: () => Promise<void> }> {
  const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!part) throw badRequest("No file uploaded");
  await fsp.mkdir(ctx.config.layout.tmp, { recursive: true });
  const file = path.join(ctx.config.layout.tmp, `upload-${crypto.randomUUID()}`);
  await pipeline(part.file, fs.createWriteStream(file));
  const cleanup = () => fsp.rm(file, { force: true });
  if (part.file.truncated) {
    await cleanup();
    throw new AppError(413, "too_large", `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  return { file, filename: part.filename, cleanup };
}

export async function serverRoutes(app: FastifyInstance, ctx: AppContext) {
  const { servers, game } = ctx;
  const row = (id: string) => servers.row(id);

  // ---- CRUD -------------------------------------------------------------------

  app.get("/api/servers", async (req) => {
    requirePermission(req, "server.view");
    return (await servers.rows()).map((r) => servers.summary(r));
  });

  app.post("/api/servers", async (req) => {
    requirePermission(req, "server.create");
    const input = parse(createServerSchema, req.body);
    const created = await servers.create(input, actorOf(req));
    return servers.detail(created);
  });

  app.get<IdParams>("/api/servers/:id", async (req) => {
    requirePermission(req, "server.view");
    return servers.detail(await row(req.params.id));
  });

  app.patch<IdParams>("/api/servers/:id", async (req) => {
    requirePermission(req, "server.configure");
    const patch = parse(updateServerSchema, req.body);
    return servers.detail(await servers.update(req.params.id, patch, actorOf(req)));
  });

  app.delete<IdParams & { Querystring: { deleteFiles?: string; backup?: string } }>("/api/servers/:id", async (req, reply) => {
    requirePermission(req, "server.delete");
    if (req.query.backup === "true") await ctx.backups.create(req.params.id, "pre-delete", actorOf(req), "Automatic backup before deletion");
    await servers.delete(req.params.id, actorOf(req), { deleteFiles: req.query.deleteFiles === "true" });
    return noContent(reply);
  });

  app.post<IdParams>("/api/servers/:id/install", async (req, reply) => {
    requirePermission(req, "server.configure");
    const r = await row(req.params.id);
    if (servers.agent.isRunning(r.id)) throw badRequest("Stop the server first");
    void servers.install(r.id, actorOf(req));
    return reply.code(202).send({ ok: true });
  });

  app.post<IdParams>("/api/servers/:id/eula", async (req, reply) => {
    requirePermission(req, "server.configure");
    const body = parse(z.object({ accept: z.literal(true) }), req.body);
    if (body.accept) await servers.acceptEula(req.params.id, actorOf(req));
    return noContent(reply);
  });

  // ---- lifecycle ------------------------------------------------------------------

  app.post<IdParams>("/api/servers/:id/start", async (req, reply) => {
    requirePermission(req, "server.control");
    await servers.start(req.params.id, actorOf(req));
    return reply.code(202).send({ ok: true });
  });
  app.post<IdParams>("/api/servers/:id/stop", async (req, reply) => {
    requirePermission(req, "server.control");
    await servers.stop(req.params.id, actorOf(req));
    return reply.code(202).send({ ok: true });
  });
  app.post<IdParams>("/api/servers/:id/restart", async (req, reply) => {
    requirePermission(req, "server.control");
    servers.restart(req.params.id, actorOf(req)).catch((err) => ctx.activity.event(req.params.id, "server.restart_failed", `Restart failed: ${(err as Error).message}`, { level: "error" }));
    return reply.code(202).send({ ok: true });
  });
  app.post<IdParams>("/api/servers/:id/kill", async (req, reply) => {
    requirePermission(req, "server.kill");
    await servers.kill(req.params.id, actorOf(req));
    return reply.code(202).send({ ok: true });
  });

  // ---- console ------------------------------------------------------------------------

  app.post<IdParams>("/api/servers/:id/command", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    requirePermission(req, "console.command");
    const { command } = parse(commandSchema, req.body);
    await row(req.params.id);
    servers.sendCommand(req.params.id, command);
    await ctx.activity.audit(actorOf(req), "console.command", req.params.id, { command });
    return noContent(reply);
  });

  app.get<IdParams & { Querystring: { limit?: string } }>("/api/servers/:id/console", async (req) => {
    requirePermission(req, "console.read");
    await row(req.params.id);
    return servers.agent.history(req.params.id, Math.min(Number(req.query.limit ?? 1000), 2000));
  });

  app.get<IdParams>("/api/servers/:id/logs/latest", async (req, reply) => {
    requirePermission(req, "console.read");
    const r = await row(req.params.id);
    const { stream, size } = await servers.sandbox(r).openRead("logs/latest.log");
    return reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Length", size).header("Content-Disposition", `attachment; filename="${r.name.replace(/[^A-Za-z0-9_-]/g, "_")}-latest.log"`).send(stream);
  });

  // ---- overview -----------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/overview", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    const [storage, disk, backupList, events] = await Promise.all([
      directorySize(r.directory),
      freeDiskSpace(r.directory),
      ctx.backups.list(r.id),
      ctx.activity.list({ serverId: r.id, limit: 15 }),
    ]);
    return {
      server: servers.detail(r),
      metrics: servers.agent.latestMetrics(r.id),
      storageBytes: storage,
      disk,
      latestBackup: backupList.find((b) => b.status === "completed") ?? null,
      events,
      addresses: connectionAddresses(r.port, r.bindAddress),
      busy: servers.busy(r.id),
    };
  });

  // ---- configuration --------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/properties", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    return { ...(await game.readProperties(r)), restartRequired: servers.restartRequired.has(r.id), running: servers.agent.isRunning(r.id) };
  });
  app.put<IdParams>("/api/servers/:id/properties", async (req, reply) => {
    requirePermission(req, "server.configure");
    const body = parse(propertiesUpdateSchema, req.body);
    await game.updateProperties(await row(req.params.id), body.values, actorOf(req));
    return noContent(reply);
  });
  app.put<IdParams>("/api/servers/:id/properties/raw", async (req, reply) => {
    requirePermission(req, "server.configure");
    const body = parse(z.object({ raw: z.string().max(256 * 1024) }), req.body);
    await game.replaceProperties(await row(req.params.id), body.raw, actorOf(req));
    return noContent(reply);
  });
  app.get<IdParams>("/api/servers/:id/properties/export", async (req, reply) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    const text = (await servers.sandbox(r).readTextIfExists("server.properties")) ?? "";
    return reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Disposition", 'attachment; filename="server.properties"').send(redactProperties(text));
  });

  app.get<IdParams>("/api/servers/:id/gamerules", async (req) => {
    requirePermission(req, "server.view");
    return game.gamerules(await row(req.params.id));
  });
  app.put<IdParams>("/api/servers/:id/gamerules", async (req, reply) => {
    requirePermission(req, "server.configure");
    const body = parse(gameruleUpdateSchema, req.body);
    await game.setGamerule(await row(req.params.id), body.name, body.value, actorOf(req));
    return noContent(reply);
  });

  // ---- players --------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/players", async (req) => {
    requirePermission(req, "server.view");
    return game.players(await row(req.params.id));
  });
  app.post<IdParams & { Params: { action: string } }>("/api/servers/:id/players/:action", async (req, reply) => {
    requirePermission(req, "players.manage");
    const action = req.params.action;
    if (action === "ip-ban" || action === "ip-pardon") {
      const body = parse(ipBanSchema, req.body);
      await game.ipBan(await row(req.params.id), body.ip, body.reason, action === "ip-pardon", actorOf(req));
    } else if (action === "whitelist-toggle") {
      const body = parse(z.object({ enabled: z.boolean() }), req.body);
      await game.setWhitelistEnabled(await row(req.params.id), body.enabled, actorOf(req));
    } else {
      // Granting Minecraft operator is a privileged action.
      if (action === "op" || action === "deop") requirePermission(req, "server.configure");
      const body = parse(playerActionSchema, req.body);
      await game.playerAction(await row(req.params.id), action, body.name, body.reason, actorOf(req));
    }
    return noContent(reply);
  });

  // ---- worlds ---------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/worlds", async (req) => {
    requirePermission(req, "server.view");
    return game.worlds(await row(req.params.id));
  });
  app.post<IdParams>("/api/servers/:id/worlds", async (req, reply) => {
    requirePermission(req, "worlds.manage");
    const body = parse(worldCreateSchema, req.body);
    await game.createWorld(await row(req.params.id), body.name, body.seed, body.levelType, body.activate, actorOf(req));
    return noContent(reply);
  });
  app.post<IdParams & { Params: { name: string } }>("/api/servers/:id/worlds/:name/select", async (req, reply) => {
    requirePermission(req, "worlds.manage");
    const name = parse(levelNameSchema, req.params.name);
    await game.selectWorld(await row(req.params.id), name, {}, actorOf(req));
    return noContent(reply);
  });
  app.delete<IdParams & { Params: { name: string } }>("/api/servers/:id/worlds/:name", async (req, reply) => {
    requirePermission(req, "worlds.manage");
    const name = parse(levelNameSchema, req.params.name);
    const r = await row(req.params.id);
    await ctx.backups.create(r.id, "pre-delete", actorOf(req), `Automatic backup before deleting world ${name}`);
    await game.deleteWorld(r, name, actorOf(req));
    return noContent(reply);
  });
  app.get<IdParams & { Params: { name: string } }>("/api/servers/:id/worlds/:name/export", async (req, reply) => {
    requirePermission(req, "worlds.manage");
    const name = parse(levelNameSchema, req.params.name);
    const file = await game.exportWorld(await row(req.params.id), name);
    const st = await fsp.stat(file);
    const stream = fs.createReadStream(file);
    stream.on("close", () => void fsp.rm(file, { force: true }));
    return reply.header("Content-Type", "application/zip").header("Content-Length", st.size).header("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.zip"`).send(stream);
  });
  app.post<IdParams & { Querystring: { name?: string } }>("/api/servers/:id/worlds/import", async (req, reply) => {
    requirePermission(req, "worlds.manage");
    const name = parse(levelNameSchema, req.query.name);
    const r = await row(req.params.id);
    const up = await receiveUpload(ctx, req, 8 * 1024 ** 3);
    try {
      await game.importWorld(r, up.file, name, actorOf(req));
    } finally {
      await up.cleanup();
    }
    return noContent(reply);
  });

  // ---- plugins --------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/plugins", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    return { supported: r.software === "paper", software: r.software, plugins: await game.plugins(r), restartRequired: servers.restartRequired.has(r.id) };
  });
  app.get<IdParams & { Querystring: { q?: string; offset?: string } }>("/api/servers/:id/plugins/search", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    return searchModrinthPlugins(String(req.query.q ?? "").slice(0, 100), r.mcVersion, Math.max(0, Number(req.query.offset ?? 0)) || 0);
  });
  app.get<IdParams & { Params: { project: string } }>("/api/servers/:id/plugins/versions/:project", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    const versions = await compatibleModrinthVersions(req.params.project, r.mcVersion);
    return versions.map((v) => ({ id: v.id, name: v.name, version: v.version_number, type: v.version_type, published: v.date_published, loaders: v.loaders, dependencies: v.dependencies }));
  });
  app.post<IdParams>("/api/servers/:id/plugins/install", async (req) => {
    requirePermission(req, "plugins.manage");
    const body = parse(z.object({ projectId: z.string().max(64), versionId: z.string().max(64).optional() }), req.body);
    return game.installFromModrinth(await row(req.params.id), body.projectId, body.versionId, actorOf(req));
  });
  app.post<IdParams>("/api/servers/:id/plugins/upload", async (req, reply) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    const up = await receiveUpload(ctx, req, 200 * 1024 * 1024);
    try {
      await game.installUploadedPlugin(r, up.file, up.filename, actorOf(req));
    } finally {
      await up.cleanup();
    }
    return noContent(reply);
  });
  app.patch<IdParams & { Params: { file: string } }>("/api/servers/:id/plugins/:file", async (req, reply) => {
    requirePermission(req, "plugins.manage");
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    await game.togglePlugin(await row(req.params.id), req.params.file, body.enabled, actorOf(req));
    return noContent(reply);
  });
  app.delete<IdParams & { Params: { file: string } }>("/api/servers/:id/plugins/:file", async (req, reply) => {
    requirePermission(req, "plugins.manage");
    await game.removePlugin(await row(req.params.id), req.params.file, actorOf(req));
    return noContent(reply);
  });
  app.get<IdParams>("/api/servers/:id/plugins/updates", async (req) => {
    requirePermission(req, "plugins.manage");
    return game.pluginUpdates(await row(req.params.id));
  });
  app.post<IdParams & { Params: { file: string } }>("/api/servers/:id/plugins/:file/update", async (req, reply) => {
    requirePermission(req, "plugins.manage");
    const body = parse(z.object({ versionId: z.string().max(64) }), req.body);
    await game.updatePlugin(await row(req.params.id), req.params.file, body.versionId, actorOf(req));
    return noContent(reply);
  });

  // ---- software change / migration ------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/software/options", async (req) => {
    requirePermission(req, "server.configure");
    const r = await row(req.params.id);
    const paper = await getProvider("paper").listVersions().catch(() => []);
    return { current: { software: r.software, version: r.mcVersion, build: r.build }, paperAvailable: paper.some((v) => v.id === r.mcVersion) };
  });

  /** Vanilla → Paper migration (or version update) with automatic backup first. */
  app.post<IdParams>("/api/servers/:id/software", async (req) => {
    requirePermission(req, "server.configure");
    const body = parse(z.object({ software: z.enum(["vanilla", "paper"]), version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), build: z.string().max(32).nullable().optional() }), req.body);
    const r = await row(req.params.id);
    if (servers.agent.isRunning(r.id)) throw badRequest("Stop the server first");
    const backup = await ctx.backups.create(r.id, r.software !== body.software ? "pre-migration" : "pre-update", actorOf(req), `Before switching to ${body.software} ${body.version}`);
    try {
      await servers.changeSoftware(r.id, body.software, body.version, body.build ?? null, actorOf(req));
    } catch (err) {
      // Roll back metadata so the previous jar (still on disk unless replaced) is used.
      await ctx.database.db.update(serversTable).set({ software: r.software, mcVersion: r.mcVersion, build: r.build, javaMajor: r.javaMajor, jarFile: r.jarFile, jarSha: r.jarSha, installState: "installed", installError: null }).where(eq(serversTable.id, r.id));
      throw new AppError(500, "migration_failed", `Migration failed and was rolled back: ${(err as Error).message}`, `A backup was taken before the change (${backup.filename}).`);
    }
    return { ok: true, backupId: backup.id };
  });

  // ---- network --------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/network", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    const settings = await ctx.settings.get();
    return {
      mode: r.networkMode,
      port: r.port,
      bindAddress: r.bindAddress,
      lan: lanAddresses(),
      addresses: connectionAddresses(r.port, r.bindAddress),
      publicIp: settings.publicIp,
      ddnsDomain: settings.ddnsProvider !== "none" ? settings.ddnsDomain : null,
      running: servers.agent.isRunning(r.id),
    };
  });
  app.put<IdParams>("/api/servers/:id/network", async (req) => {
    requirePermission(req, "network.manage");
    const body = parse(
      z.object({
        mode: z.enum(["lan", "wan"]),
        port: portSchema,
        bindAddress: z.string().max(64).refine((s) => s === "" || /^[0-9.]+$|^[0-9a-fA-F:]+$/.test(s), "Must be an IP address or empty"),
      }),
      req.body,
    );
    if (body.bindAddress && !lanAddresses().some((a) => a.address === body.bindAddress) && body.bindAddress !== "127.0.0.1")
      throw badRequest("That address does not belong to a network interface on this machine");
    const updated = await servers.update(req.params.id, { networkMode: body.mode, port: body.port, bindAddress: body.bindAddress }, actorOf(req));
    return servers.detail(updated);
  });
  app.post<IdParams & { Querystring: { lookupPublicIp?: string } }>("/api/servers/:id/network/diagnose", async (req) => {
    requirePermission(req, "network.manage");
    const r = await row(req.params.id);
    let publicIp = (await ctx.settings.get()).publicIp;
    if (req.query.lookupPublicIp === "true") {
      publicIp = await fetchPublicIp().catch(() => null);
      if (publicIp) await ctx.settings.set({ publicIp });
    }
    return diagnoseWan({ port: r.port, running: servers.agent.status(r.id) === "running", publicIp });
  });
}

function connectionAddresses(port: number, bind: string) {
  const lan = lanAddresses();
  const hosts = bind && bind !== "0.0.0.0" ? [bind] : lan.map((a) => a.address);
  return {
    local: formatAddress("localhost", port),
    lan: hosts.filter((h) => isPrivateIPv4(h) || h.startsWith("100.")).map((h) => formatAddress(h, port)),
  };
}

function redactProperties(text: string) {
  return text.replace(/^(rcon\.password\s*[=:]).*$/m, "$1");
}
