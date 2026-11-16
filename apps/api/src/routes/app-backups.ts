import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, noContent, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";

/** Application backups hold password hashes and API keys: owners only (`app.configure`). */
export async function appBackupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/app-backups", async (req) => {
    requirePermission(req, "app.configure");
    return { backups: await ctx.appBackups.list(), progress: ctx.appBackups.progress() };
  });
  app.post("/api/app-backups", async (req, reply) => {
    requirePermission(req, "app.configure");
    const body = parse(z.object({ includeServers: z.boolean().default(false) }).default({ includeServers: false }), req.body);
    ctx.appBackups.start(body.includeServers, actorOf(req));
    return reply.code(202).send(ctx.appBackups.progress());
  });
  app.get<{ Params: { filename: string } }>("/api/app-backups/:filename/download", async (req, reply) => {
    requirePermission(req, "app.configure");
    const file = await ctx.appBackups.file(req.params.filename);
    const { size } = await fsp.stat(file);
    await ctx.activity.audit(actorOf(req), "app-backup.download", null, { filename: req.params.filename });
    return reply.header("Content-Type", "application/zip").header("Content-Length", size).header("Content-Disposition", `attachment; filename="${req.params.filename}"`).header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.delete<{ Params: { filename: string } }>("/api/app-backups/:filename", async (req, reply) => {
    requirePermission(req, "app.configure");
    await ctx.appBackups.remove(req.params.filename, actorOf(req));
    return noContent(reply);
  });
}
