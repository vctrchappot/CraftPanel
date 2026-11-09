import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AppError,
  applyPresetFlags,
  assessHost,
  badRequest,
  commandSchema,
  createServerSchema,
  detectPreset,
  gameruleUpdateSchema,
  ipBanSchema,
  levelNameSchema,
  PERFORMANCE_PRESETS,
  playerActionSchema,
  portSchema,
  PRESET_INFO,
  presetJvmFlags,
  propertiesUpdateSchema,
  proxyConfigSchema,
  recommendPreset,
  SERVER_SOFTWARE,
  SOFTWARE_INFO,
  updateServerSchema,
  worldCreateSchema,
  type ConnectAddress,
} from "@craftpanel/shared";
import { eq, servers as serversTable } from "@craftpanel/database";
import { detectHost, directorySize, freeDiskSpace } from "@craftpanel/server-runtime";
import { classifyAdapter, diagnoseWan, formatAddress, lanAddresses, fetchPublicIp, isCgnatIPv4, isPrivateIPv4 } from "@craftpanel/network";
import { getProvider, listModpackVersions, searchModpacks } from "@craftpanel/minecraft-providers";
import { actorOf, canSee, noContent, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";
import { isDowngrade, previewSwitch } from "../services/software-switch";

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
    const me = requirePermission(req, "server.view");
    return (await servers.rows()).filter((r) => canSee(me, r.id)).map((r) => servers.summary(r));
  });

  app.post("/api/servers", async (req) => {
    requirePermission(req, "server.create");
    const input = parse(createServerSchema, req.body);
    const created = await servers.create(input, actorOf(req));
    return servers.detail(created);
  });

  // ---- modpacks (prepared before a server is created from them) -----------------------------

  app.get<{ Querystring: { q?: string; offset?: string } }>("/api/modpacks/search", async (req) => {
    requirePermission(req, "server.create");
    return searchModpacks(String(req.query.q ?? "").slice(0, 100), Number(req.query.offset) || 0);
  });
  app.get<{ Params: { project: string } }>("/api/modpacks/:project/versions", async (req) => {
    requirePermission(req, "server.create");
    return listModpackVersions(req.params.project);
  });
  app.post("/api/modpacks/modrinth", async (req) => {
    requirePermission(req, "server.create");
    const { versionId } = parse(z.object({ versionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), req.body);
    return servers.modpacks.fromModrinth(versionId);
  });
  app.post("/api/modpacks/upload", async (req) => {
    requirePermission(req, "server.create");
    const up = await receiveUpload(ctx, req, 1024 ** 3);
    try {
      return await servers.modpacks.fromUpload(up.file);
    } finally {
      await up.cleanup();
    }
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
    await servers.sendCommand(req.params.id, command);
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
  // ---- performance ---------------------------------------------------------------

  // Metrics sampled since the last start. Sampling runs while a dashboard has the server open.
  app.get<IdParams>("/api/servers/:id/metrics", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    return { samples: servers.metricsHistory(r.id) };
  });

  app.get<IdParams>("/api/servers/:id/performance", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    // A proxy has no view distance; only the garbage collector flags apply.
    const values = SOFTWARE_INFO[r.software].proxy ? {} : (await game.readProperties(r)).values;
    const num = (k: string) => (values[k] !== undefined && values[k] !== "" ? Number(values[k]) : null);
    const viewDistance = num("view-distance");
    const simulationDistance = num("simulation-distance");
    const host = detectHost();
    // Memory and CPU the other running servers already take; this server counts as itself, not as a neighbour.
    const others = (await servers.rows()).filter((o) => o.id !== r.id && servers.agent.isRunning(o.id));
    const disk = await freeDiskSpace(r.directory);
    const fit = assessHost(
      { arch: host.arch, cpus: host.cpus, memoryBytes: host.memoryBytes, board: host.board, freeDiskBytes: disk?.free },
      { software: r.software, maxPlayers: num("max-players") ?? 20, viewDistance, memoryMb: r.memoryMb },
      { count: others.length, heapMb: others.reduce((n, o) => n + o.memoryMb, 0) },
    );
    return {
      current: detectPreset(r.jvmArgs, r.memoryMb, viewDistance, simulationDistance),
      recommended: recommendPreset(host),
      fit,
      viewDistance,
      simulationDistance,
      presets: PERFORMANCE_PRESETS.map((id) => ({ id, ...PRESET_INFO[id], jvmFlags: presetJvmFlags(id, r.memoryMb) })),
    };
  });
  app.post<IdParams>("/api/servers/:id/performance", async (req) => {
    requirePermission(req, "server.configure");
    const { preset } = parse(z.object({ preset: z.enum(PERFORMANCE_PRESETS) }), req.body);
    const r = await row(req.params.id);
    const info = PRESET_INFO[preset];
    await servers.update(r.id, { jvmArgs: applyPresetFlags(r.jvmArgs, preset, r.memoryMb) }, actorOf(req));
    if (!SOFTWARE_INFO[r.software].proxy)
      await game.updateProperties(await row(r.id), { "view-distance": String(info.viewDistance), "simulation-distance": String(info.simulationDistance) }, actorOf(req));
    await ctx.activity.event(r.id, "server.performance_preset", `Applied the "${info.label}" performance preset`, { actor: actorOf(req) });
    return servers.detail(await row(r.id));
  });

  // ---- Velocity proxy ------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/proxy", async (req) => {
    requirePermission(req, "server.view");
    return ctx.proxies.overview(await row(req.params.id));
  });
  app.put<IdParams>("/api/servers/:id/proxy", async (req) => {
    requirePermission(req, "server.configure");
    const body = parse(proxyConfigSchema, req.body);
    const r = await row(req.params.id);
    // Saving reconfigures every backend (forwarding, online-mode, bind address), including the ones being removed,
    // so the user needs the same right on each of them, not only on the proxy.
    const current = (await ctx.proxies.config(r)).backends.map((b) => b.serverId);
    for (const id of new Set([...current, ...body.backends.map((b) => b.serverId)])) requirePermission(req, "server.configure", id);
    return ctx.proxies.save(r, body, actorOf(req));
  });
  // The forwarding secret lets anyone who can reach a backend log in as any player; configure only.
  app.get<IdParams>("/api/servers/:id/proxy/secret", async (req, reply) => {
    requirePermission(req, "server.configure");
    reply.header("Cache-Control", "no-store");
    return { secret: await ctx.proxies.revealSecret(await row(req.params.id)) };
  });
  app.post<IdParams>("/api/servers/:id/proxy/secret", async (req, reply) => {
    requirePermission(req, "server.configure");
    await ctx.proxies.regenerateSecret(await row(req.params.id), actorOf(req));
    return noContent(reply);
  });

  // ---- world pre-generation (Chunky) ------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/pregen", async (req) => {
    requirePermission(req, "server.view");
    return ctx.pregen.status(await row(req.params.id));
  });
  app.post<IdParams>("/api/servers/:id/pregen/install", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    await ctx.pregen.install(r, actorOf(req));
    return ctx.pregen.status(await row(r.id));
  });
  app.post<IdParams>("/api/servers/:id/pregen", async (req) => {
    requirePermission(req, "console.command");
    const body = parse(z.object({ action: z.enum(["start", "pause", "continue", "cancel"]), radius: z.number().int().min(100).max(30_000).optional() }), req.body);
    const r = await row(req.params.id);
    await ctx.pregen.control(r, body.action, body.radius);
    await ctx.activity.audit(actorOf(req), `pregen.${body.action}`, r.id, body.radius ? { radius: body.radius } : undefined);
    if (body.action === "start") await ctx.activity.event(r.id, "world.pregen_started", `Pre-generating the world within ${body.radius ?? 1000} blocks of spawn`, { actor: actorOf(req) });
    return ctx.pregen.status(r);
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
  app.get<{ Params: { id: string; name: string }; Querystring: { tz?: string } }>("/api/servers/:id/players/:name/profile", async (req) => {
    requirePermission(req, "server.view");
    const tz = Number(req.query.tz);
    return game.playerProfile(await row(req.params.id), req.params.name, Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? Math.round(tz) : 0);
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
    return reply.header("Content-Type", "application/zip").header("Content-Length", st.size).header("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.zip"`).send(stream);
  });
  app.post<IdParams & { Querystring: { name?: string; activate?: string } }>("/api/servers/:id/worlds/import", async (req) => {
    requirePermission(req, "worlds.manage");
    const name = parse(levelNameSchema, req.query.name);
    const r = await row(req.params.id);
    const up = await receiveUpload(ctx, req, 8 * 1024 ** 3);
    try {
      return await game.importWorld(r, up.file, name, req.query.activate === "true", actorOf(req));
    } finally {
      await up.cleanup();
    }
  });

  // ---- plugins --------------------------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/plugins", async (req) => {
    requirePermission(req, "server.view");
    const r = await row(req.params.id);
    const kind = SOFTWARE_INFO[r.software].addons;
    return { supported: kind !== null, kind, software: r.software, plugins: await game.plugins(r), restartRequired: servers.restartRequired.has(r.id) };
  });
  app.get<IdParams & { Querystring: { q?: string; offset?: string } }>("/api/servers/:id/plugins/search", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    return game.searchModrinth(r, String(req.query.q ?? "").slice(0, 100), Math.max(0, Number(req.query.offset ?? 0)) || 0);
  });
  app.get<IdParams & { Params: { project: string } }>("/api/servers/:id/plugins/versions/:project", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    const versions = await game.modrinthVersions(r, req.params.project);
    return versions.map((v) => ({ id: v.id, name: v.name, version: v.version_number, type: v.version_type, published: v.date_published, loaders: v.loaders, dependencies: v.dependencies }));
  });
  app.post<IdParams>("/api/servers/:id/plugins/install", async (req) => {
    requirePermission(req, "plugins.manage");
    const body = parse(z.object({ projectId: z.string().max(64), versionId: z.string().max(64).optional() }), req.body);
    return game.installFromModrinth(await row(req.params.id), body.projectId, body.versionId, actorOf(req));
  });
  app.get<IdParams & { Querystring: { q?: string; offset?: string } }>("/api/servers/:id/plugins/hangar/search", async (req) => {
    requirePermission(req, "plugins.manage");
    const r = await row(req.params.id);
    return game.searchHangar(r, String(req.query.q ?? "").slice(0, 100), Math.max(0, Number(req.query.offset ?? 0)) || 0);
  });
  app.get<IdParams & { Params: { project: string } }>("/api/servers/:id/plugins/hangar/versions/:project", async (req) => {
    requirePermission(req, "plugins.manage");
    return game.hangarVersions(await row(req.params.id), req.params.project);
  });
  app.post<IdParams>("/api/servers/:id/plugins/hangar/install", async (req) => {
    requirePermission(req, "plugins.manage");
    const body = parse(z.object({ project: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), versionId: z.string().regex(/^\d{1,12}$/).optional() }), req.body);
    return game.installFromHangar(await row(req.params.id), body.project, body.versionId, actorOf(req));
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
    const body = parse(z.object({ versionId: z.string().max(64), source: z.enum(["modrinth", "hangar"]).default("modrinth") }), req.body);
    await game.updatePlugin(await row(req.params.id), req.params.file, body.versionId, actorOf(req), body.source);
    return noContent(reply);
  });

  // ---- software change / migration ------------------------------------------------------

  app.get<IdParams>("/api/servers/:id/software/options", async (req) => {
    requirePermission(req, "server.configure");
    const r = await row(req.params.id);
    const paper = await getProvider("paper").listVersions().catch(() => []);
    const purpur = await getProvider("purpur").listVersions().catch(() => []);
    return {
      current: { software: r.software, version: r.mcVersion, build: r.build },
      paperAvailable: paper.some((v) => v.id === r.mcVersion),
      purpurAvailable: purpur.some((v) => v.id === r.mcVersion),
    };
  });

  /** A proxy only updates to another Velocity version; it can't become a Minecraft server or the other way round. */
  const requireSameKind = (from: keyof typeof SOFTWARE_INFO, to: keyof typeof SOFTWARE_INFO) => {
    if (SOFTWARE_INFO[from].proxy !== SOFTWARE_INFO[to].proxy) throw badRequest(SOFTWARE_INFO[from].proxy ? "A proxy can only be updated to another Velocity version" : "A Minecraft server can't be turned into a proxy; create a Velocity server instead");
  };
  const switchTarget = z.object({ software: z.enum(SERVER_SOFTWARE), version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) });

  /** What a switch would do: backup, world upgrade or downgrade, add-ons that stop loading, folders that move. */
  app.get<IdParams & { Querystring: { software?: string; version?: string } }>("/api/servers/:id/software/preview", async (req) => {
    requirePermission(req, "server.configure");
    const to = parse(switchTarget, req.query);
    const r = await row(req.params.id);
    requireSameKind(r.software, to.software);
    return previewSwitch(servers.sandbox(r), { software: r.software, version: r.mcVersion, javaMajor: r.javaMajor }, to);
  });

  /** Software migration (e.g. Vanilla → Paper, Paper → Fabric) or version/build update, with an automatic backup first. */
  app.post<IdParams>("/api/servers/:id/software", async (req) => {
    requirePermission(req, "server.configure");
    const body = parse(switchTarget.extend({ build: z.string().max(32).nullable().optional(), allowDowngrade: z.boolean().optional() }), req.body);
    const r = await row(req.params.id);
    if (servers.agent.isRunning(r.id)) throw badRequest("Stop the server first");
    requireSameKind(r.software, body.software);
    if (!body.allowDowngrade && !SOFTWARE_INFO[r.software].proxy && (await isDowngrade(r.mcVersion, body.version)))
      throw new AppError(409, "downgrade", `Minecraft ${body.version} is older than ${r.mcVersion}`, "Worlds saved by a newer version can break on an older one. Confirm the downgrade to continue anyway.");
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

/**
 * Addresses players can connect to. `lan` stays a plain list for older clients; `network` labels each one
 * (real LAN first, then VPN and virtual adapters such as WSL, Hyper-V, Docker or VirtualBox).
 */
function connectionAddresses(port: number, bind: string): { local: string; lan: string[]; network: ConnectAddress[] } {
  const lan = lanAddresses();
  const bound = bind && bind !== "0.0.0.0" ? [lan.find((a) => a.address === bind) ?? { address: bind, interface: "", ...classifyAdapter("", bind) }] : lan;
  const network = bound
    .filter((a) => isPrivateIPv4(a.address) || isCgnatIPv4(a.address))
    .map((a): ConnectAddress => ({ address: formatAddress(a.address, port), kind: a.kind, label: a.label, ...(a.interface ? { interface: a.interface } : {}) }));
  return { local: formatAddress("localhost", port), lan: network.map((a) => a.address), network };
}

function redactProperties(text: string) {
  return text.replace(/^(rcon\.password\s*[=:]).*$/m, "$1");
}
