import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, noContent, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";
import { AppError } from "@craftpanel/shared";
import { createRestoreWorkspace } from "../setup-restore-transaction";

/** Application backups hold password hashes and API keys: owners only (`app.configure`). */
export async function appBackupRoutes(app: FastifyInstance, ctx: AppContext) {
  // Like owner creation, this is protected by first-run state, Origin and the host's setup token.
  app.post("/api/auth/restore", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    const release = ctx.setup.reserve();
    let work: string | undefined;
    let started = false;
    try {
      const token = req.headers["x-setup-token"];
      ctx.setup.assertFresh(typeof token === "string" ? token : undefined);
      work = await createRestoreWorkspace(ctx.config.layout);
      const file = path.join(work, "uploaded-backup");
      let received = false;
      let passphrase: string | undefined;
      for await (const part of req.parts({ limits: { files: 1, fields: 1, parts: 2, fileSize: 2 * 1024 ** 3, fieldSize: 4096 } })) {
        if (part.type === "file") {
          await pipeline(part.file, fs.createWriteStream(file, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) throw new AppError(413, "too_large", "The backup exceeds the 2 GB browser upload limit. Use offline import for larger archives.");
          received = true;
        } else if (part.fieldname === "passphrase") passphrase = parse(z.string().max(1024), part.value) || undefined;
        else throw new AppError(400, "bad_request", "Unknown restore field");
      }
      if (!received) throw new AppError(400, "bad_request", "Choose an application backup file");
      const result = ctx.setup.start(file, work, passphrase, release);
      started = true;
      return reply.code(202).send(result);
    } finally {
      if (!started) { if (work) await fsp.rm(work, { recursive: true, force: true }); release(); }
    }
  });
  app.get("/api/auth/restore/status", async (req) => {
    const token = req.headers["x-restore-token"];
    return ctx.setup.status(typeof token === "string" ? token : undefined);
  });

  app.get("/api/app-backups", async (req) => {
    requirePermission(req, "app.configure");
    return { backups: await ctx.appBackups.list(), progress: ctx.appBackups.progress() };
  });
  app.post("/api/app-backups", async (req, reply) => {
    requirePermission(req, "app.configure");
    const body = parse(z.object({ includeServers: z.boolean().default(false), includeBackupHistory: z.boolean().default(false), passphrase: z.string().min(10).max(1024).optional() }).default({ includeServers: false, includeBackupHistory: false }), req.body);
    ctx.appBackups.start(body.includeServers, actorOf(req), body);
    return reply.code(202).send(ctx.appBackups.progress());
  });
  app.get<{ Params: { filename: string } }>("/api/app-backups/:filename/download", async (req, reply) => {
    requirePermission(req, "app.configure");
    const file = await ctx.appBackups.file(req.params.filename);
    const { size } = await fsp.stat(file);
    await ctx.activity.audit(actorOf(req), "app-backup.download", null, { filename: req.params.filename });
    return reply.header("Content-Type", file.endsWith(".cpbackup") ? "application/octet-stream" : "application/zip").header("Content-Length", size).header("Content-Disposition", `attachment; filename="${req.params.filename}"`).header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.delete<{ Params: { filename: string } }>("/api/app-backups/:filename", async (req, reply) => {
    requirePermission(req, "app.configure");
    await ctx.appBackups.remove(req.params.filename, actorOf(req));
    return noContent(reply);
  });
}
