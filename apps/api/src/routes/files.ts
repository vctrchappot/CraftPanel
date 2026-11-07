import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, badRequest, fileRenameSchema, fileWriteSchema, filePathSchema } from "@craftpanel/shared";
import { createZip, extractZip } from "@craftpanel/backup";
import { actorOf, noContent, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";

type P = { Params: { id: string }; Querystring: { path?: string } };

/** Files whose modification while the server runs is likely to be overwritten or unsafe. */
const PROTECTED = new Set([".craftpanel"]);

/**
 * Sandboxed file manager. Every path goes through ServerSandbox, which
 * rejects traversal, absolute paths and symlinks.
 */
export async function fileRoutes(app: FastifyInstance, ctx: AppContext) {
  const sandbox = async (id: string) => ctx.servers.sandbox(await ctx.servers.row(id));
  const guard = (rel: string) => {
    const top = rel.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0];
    if (PROTECTED.has(top)) throw new AppError(403, "forbidden", "This file is managed by CraftPanel");
  };

  app.get<P>("/api/servers/:id/files", async (req) => {
    requirePermission(req, "files.read");
    const sb = await sandbox(req.params.id);
    const rel = req.query.path ?? "";
    return { path: rel, entries: (await sb.list(rel)).filter((e) => !PROTECTED.has(e.name)) };
  });

  app.get<P>("/api/servers/:id/files/content", async (req) => {
    requirePermission(req, "files.read");
    const sb = await sandbox(req.params.id);
    const rel = parse(z.string().min(1).max(4096), req.query.path);
    guard(rel);
    return { path: rel, content: await sb.readText(rel) };
  });

  app.put<P>("/api/servers/:id/files/content", async (req, reply) => {
    requirePermission(req, "files.write");
    const body = parse(fileWriteSchema, req.body);
    guard(body.path);
    const sb = await sandbox(req.params.id);
    await sb.writeText(body.path, body.content);
    await ctx.activity.audit(actorOf(req), "file.write", req.params.id, { path: body.path });
    return noContent(reply);
  });

  app.get<P>("/api/servers/:id/files/download", async (req, reply) => {
    requirePermission(req, "files.read");
    const sb = await sandbox(req.params.id);
    const rel = parse(z.string().max(4096), req.query.path ?? "");
    guard(rel);
    const abs = await sb.resolve(rel);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      // Directories are zipped on the fly into a temp file.
      const tmp = path.join(ctx.config.layout.tmp, `dl-${crypto.randomUUID()}.zip`);
      await createZip({ sourceDir: abs, destination: tmp, exclude: (r) => /(^|\/)session\.lock$/.test(r) || PROTECTED.has(r) });
      const size = (await fsp.stat(tmp)).size;
      const stream = fs.createReadStream(tmp);
      stream.on("close", () => void fsp.rm(tmp, { force: true }));
      const name = (path.basename(abs) || "server").replace(/[^A-Za-z0-9_.-]/g, "_");
      return reply.header("Content-Type", "application/zip").header("Content-Length", size).header("Content-Disposition", `attachment; filename="${name}.zip"`).send(stream);
    }
    const { stream, size, name } = await sb.openRead(rel);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", size)
      .header("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, "_")}"`)
      .send(stream);
  });

  /** Upload into a directory; `?extract=true` safely unpacks a .zip. */
  app.post<P & { Querystring: { path?: string; extract?: string } }>("/api/servers/:id/files/upload", async (req, reply) => {
    requirePermission(req, "files.write");
    const sb = await sandbox(req.params.id);
    const dir = req.query.path ?? "";
    guard(dir);
    const part = await req.file({ limits: { fileSize: 2 * 1024 ** 3, files: 1 } });
    if (!part) throw badRequest("No file uploaded");
    const filename = path.basename(part.filename).replace(/[\\/:*?"<>|\0]/g, "_");
    if (!filename || filename === "." || filename === "..") throw badRequest("Invalid file name");
    const rel = dir ? `${dir.replace(/\/+$/, "")}/${filename}` : filename;
    guard(rel);

    if (req.query.extract === "true") {
      if (!filename.toLowerCase().endsWith(".zip")) throw badRequest("Only .zip archives can be extracted");
      const tmp = path.join(ctx.config.layout.tmp, `upload-${crypto.randomUUID()}.zip`);
      await fsp.mkdir(ctx.config.layout.tmp, { recursive: true });
      try {
        await pipeline(part.file, fs.createWriteStream(tmp));
        if (part.file.truncated) throw new AppError(413, "too_large", "File too large");
        await extractZip({ file: tmp, destination: await sb.resolve(dir) });
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    } else {
      const w = await sb.writeStream(rel);
      try {
        await pipeline(part.file, w.stream);
        if (part.file.truncated) throw new AppError(413, "too_large", "File too large");
        await w.finalize();
      } catch (err) {
        await w.abort();
        throw err;
      }
    }
    await ctx.activity.audit(actorOf(req), "file.upload", req.params.id, { path: rel, extract: req.query.extract === "true" });
    return noContent(reply);
  });

  app.post<P>("/api/servers/:id/files/mkdir", async (req, reply) => {
    requirePermission(req, "files.write");
    const body = parse(filePathSchema, req.body);
    guard(body.path);
    await (await sandbox(req.params.id)).mkdir(body.path);
    return noContent(reply);
  });

  app.post<P>("/api/servers/:id/files/rename", async (req, reply) => {
    requirePermission(req, "files.write");
    const body = parse(fileRenameSchema, req.body);
    guard(body.from);
    guard(body.to);
    await (await sandbox(req.params.id)).rename(body.from, body.to);
    await ctx.activity.audit(actorOf(req), "file.rename", req.params.id, body);
    return noContent(reply);
  });

  app.delete<P>("/api/servers/:id/files", async (req, reply) => {
    requirePermission(req, "files.write");
    const rel = parse(z.string().min(1).max(4096), req.query.path);
    guard(rel);
    const r = await ctx.servers.row(req.params.id);
    if (ctx.servers.agent.isRunning(r.id) && /\.jar$/i.test(rel) && !rel.includes("/")) throw badRequest("Stop the server before deleting its jar");
    await ctx.servers.sandbox(r).remove(rel);
    await ctx.activity.audit(actorOf(req), "file.delete", req.params.id, { path: rel });
    return noContent(reply);
  });

}
