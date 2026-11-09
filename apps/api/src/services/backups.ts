import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { backups, desc, eq, servers, type Database } from "@craftpanel/database";
import { APP_LOCALE, conflict, notFound, SOFTWARE_INFO, type BackupInfo } from "@craftpanel/shared";
import { createZip, extractZip, LocalBackupStorage, verifyZip } from "@craftpanel/backup";
import { freeDiskSpace } from "@craftpanel/server-runtime";
import type { Hub } from "../hub";
import type { AppConfig } from "../config";
import type { ActivityService, Actor } from "./activity";
import type { ServerRow, ServerService } from "./servers";
import type { SettingsService } from "./settings";

type BackupRow = typeof backups.$inferSelect;

/** Top-level entries never archived nor replaced on restore (re-downloadable or transient). */
const EXCLUDED_TOP = new Set(["cache", "libraries", "versions", "logs", "crash-reports", "bundler", ".craftpanel"]);
const isExcluded = (rel: string) => {
  const top = rel.split("/")[0];
  if (EXCLUDED_TOP.has(top)) return true;
  if (!rel.includes("/") && /\.jar$/i.test(rel)) return true;
  if (/(^|\/)session\.lock$/.test(rel)) return true;
  if (/\.(tmp|download|partial)$/.test(rel)) return true;
  return false;
};

export class BackupService {
  private running = new Set<string>();

  constructor(
    private db: Database,
    private servers: ServerService,
    private hub: Hub,
    private activity: ActivityService,
    private settings: SettingsService,
    private config: AppConfig,
  ) {}

  private async storage() {
    const s = await this.settings.get();
    return new LocalBackupStorage(s.backupDirectory || this.config.layout.backups);
  }

  toInfo(r: BackupRow, serverName?: string): BackupInfo {
    return {
      id: r.id,
      serverId: r.serverId,
      serverName,
      filename: r.filename,
      size: r.size,
      sha256: r.sha256,
      kind: r.kind as BackupInfo["kind"],
      status: r.status,
      error: r.error,
      note: r.note,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  async list(serverId?: string): Promise<BackupInfo[]> {
    const q = this.db.select({ b: backups, name: servers.name }).from(backups).leftJoin(servers, eq(backups.serverId, servers.id));
    const rows = await (serverId ? q.where(eq(backups.serverId, serverId)) : q).orderBy(desc(backups.createdAt));
    return rows.map((r) => this.toInfo(r.b, r.name ?? undefined));
  }

  async get(id: string): Promise<BackupRow> {
    const [row] = await this.db.select().from(backups).where(eq(backups.id, id));
    if (!row) throw notFound("Backup");
    return row;
  }

  async filePath(row: BackupRow): Promise<string> {
    return (await this.storage()).localPath(row.storageKey);
  }

  /**
   * Create a backup. While the server runs, autosave is paused and a full
   * flush is forced so region files are consistent while being copied.
   */
  async create(serverId: string, kind: BackupInfo["kind"], actor: Actor, note?: string): Promise<BackupInfo> {
    const server = await this.servers.row(serverId);
    // Refuse an unknown runtime before allocating a running backup record or touching files.
    const live = !SOFTWARE_INFO[server.software].proxy && this.servers.agent.isRunning(serverId) && this.servers.agent.status(serverId) === "running";
    if (this.running.has(serverId)) throw conflict("A backup of this server is already running");
    const id = crypto.randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${server.name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32)}-${stamp}-${kind}.zip`;
    const storageKey = `${serverId}/${filename}`;
    const now = Date.now();
    await this.db.insert(backups).values({ id, serverId, filename, storageKey, kind, status: "running", note: note ?? null, createdAt: now });
    this.running.add(serverId);
    const emit = (status: string, percent?: number | null, message?: string) => this.hub.broadcast({ type: "backup", serverId, backupId: id, status, percent, message });
    emit("running", 0, "Preparing backup");

    // A proxy has no world to flush.
    try {
      const storage = await this.storage();
      const dest = storage.stagingPath(storageKey);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const disk = await freeDiskSpace(path.dirname(dest));
      if (disk && disk.free < 512 * 1024 ** 2) throw new Error("Less than 512 MB free at the backup destination");

      if (live) {
        emit("running", 0, "Flushing world data to disk");
        await this.servers.agent.query(serverId, "save-off", /Automatic saving is now disabled|Saving is already turned off/i, { timeoutMs: 10000 });
        const saved = await this.servers.agent.query(serverId, "save-all flush", /^Saved the (game|world)/i, { timeoutMs: 120000, swallow: /^Saving the game|^Saving\.\.\.|^ThreadedAnvilChunkStorage/i });
        if (!saved) throw new Error("The server did not confirm the world save in time");
      }
      const result = await createZip({
        sourceDir: server.directory,
        destination: dest,
        exclude: (rel) => isExcluded(rel),
        onProgress: (p) => emit("running", p.totalBytes ? Math.round((p.bytesProcessed / p.totalBytes) * 100) : null, p.currentFile ? `Archiving ${p.currentFile}` : "Archiving"),
      });
      if (!this.servers.agent.connected) throw new Error("Runtime connection lost during backup; world consistency cannot be confirmed");
      await storage.commit(storageKey);
      await this.db.update(backups).set({ status: "completed", size: result.size, sha256: result.sha256, completedAt: Date.now() }).where(eq(backups.id, id));
      emit("completed", 100, "Backup complete");
      await this.activity.event(serverId, "backup.completed", `Backup created (${(result.size / 1024 / 1024).toFixed(1)} MB, ${kind})`, { actor });
    } catch (err) {
      const message = (err as Error).message;
      await this.db.update(backups).set({ status: "failed", error: message, completedAt: Date.now() }).where(eq(backups.id, id));
      emit("failed", null, message);
      await this.activity.event(serverId, "backup.failed", `Backup failed: ${message}`, { level: "error", actor });
      throw err;
    } finally {
      if (live) {
        try {
          if (this.servers.agent.isRunning(serverId)) await this.servers.agent.send(serverId, "save-on");
        } catch {
          /* stopped meanwhile */
        }
      }
      this.running.delete(serverId);
    }
    if (kind === "scheduled" || kind === "manual") void this.applyRetention(serverId).catch(() => undefined);
    return this.toInfo(await this.get(id));
  }

  async verify(id: string) {
    const row = await this.get(id);
    if (row.status !== "completed") return { ok: false, entries: 0, error: "Backup is not complete" };
    return verifyZip(await this.filePath(row), row.sha256);
  }

  /**
   * Restore a backup over a stopped server. A safety backup is taken first,
   * the archive is verified, extracted to a staging directory, and only then
   * swapped in.
   */
  async restore(id: string, actor: Actor): Promise<void> {
    const row = await this.get(id);
    if (row.status !== "completed") throw conflict("Only completed backups can be restored");
    const server = await this.servers.row(row.serverId);
    if (this.servers.agent.isRunning(server.id) || this.servers.status(server) === "orphaned") throw conflict("Stop the server before restoring a backup");

    await this.servers.withLock(server.id, "restore", async () => {
      const emit = (status: string, percent?: number | null, message?: string) => this.hub.broadcast({ type: "backup", serverId: server.id, backupId: id, status, percent, message });
      emit("restoring", null, "Verifying backup integrity");
      const file = await this.filePath(row);
      const check = await verifyZip(file, row.sha256);
      if (!check.ok) throw conflict(`Backup failed verification: ${check.error}`);

      emit("restoring", null, "Creating safety backup of current state");
      this.running.delete(server.id);
      await this.createUnlocked(server, actor);

      const staging = path.join(path.dirname(server.directory), `.restore-${server.id.slice(0, 8)}-${Date.now()}`);
      try {
        await extractZip({ file, destination: staging, onProgress: (p) => emit("restoring", p.totalBytes ? Math.round((p.bytesProcessed / p.totalBytes) * 100) : null, "Extracting") });
        emit("restoring", null, "Replacing server files");
        for (const name of await fsp.readdir(server.directory)) {
          if (isExcluded(name)) continue;
          await fsp.rm(path.join(server.directory, name), { recursive: true, force: true });
        }
        for (const name of await fsp.readdir(staging)) {
          if (isExcluded(name)) continue;
          await fsp.rename(path.join(staging, name), path.join(server.directory, name));
        }
      } finally {
        await fsp.rm(staging, { recursive: true, force: true });
      }
      // Ports and bind address are owned by CraftPanel; re-apply them.
      await this.servers.syncManagedProperties(await this.servers.row(server.id));
      emit("restored", 100, "Restore complete");
      await this.activity.event(server.id, "backup.restored", `Restored backup from ${new Date(row.createdAt).toLocaleString(APP_LOCALE, { dateStyle: "medium", timeStyle: "short" })}`, { actor, level: "warn" });
      await this.activity.audit(actor, "backup.restore", id, { serverId: server.id });
    });
  }

  /** Pre-restore backup without re-acquiring the server lock. */
  private async createUnlocked(server: ServerRow, actor: Actor) {
    await this.create(server.id, "pre-restore", actor, "Automatic backup before restore");
  }

  async remove(id: string, actor: Actor) {
    const row = await this.get(id);
    if (row.status === "running") throw conflict("Backup is still running");
    await (await this.storage()).remove(row.storageKey);
    await this.db.delete(backups).where(eq(backups.id, id));
    await this.activity.audit(actor, "backup.delete", id, { serverId: row.serverId });
  }

  /** Keep only the newest N completed backups per server (safety backups are kept 7 days). */
  async applyRetention(serverId: string, keep?: number): Promise<number> {
    const limit = keep ?? (await this.settings.get()).backupRetention;
    const rows = await this.db.select().from(backups).where(eq(backups.serverId, serverId)).orderBy(desc(backups.createdAt));
    const regular = rows.filter((r) => r.status === "completed" && (r.kind === "manual" || r.kind === "scheduled"));
    const safety = rows.filter((r) => r.status === "completed" && r.kind.startsWith("pre-") && Date.now() - r.createdAt > 7 * 86400_000);
    const doomed = [...regular.slice(limit), ...safety];
    const failed = rows.filter((r) => r.status === "failed" && Date.now() - r.createdAt > 86400_000);
    const storage = await this.storage();
    for (const r of [...doomed, ...failed]) {
      await storage.remove(r.storageKey);
      await this.db.delete(backups).where(eq(backups.id, r.id));
    }
    return doomed.length;
  }

  /** Mark backups interrupted by an application restart as failed. */
  async recover() {
    const rows = await this.db.select().from(backups).where(eq(backups.status, "running"));
    const storage = await this.storage();
    for (const r of rows) {
      await fsp.rm((await storage.localPath(r.storageKey)) + ".partial", { force: true });
      await this.db.update(backups).set({ status: "failed", error: "Interrupted by an application restart" }).where(eq(backups.id, r.id));
    }
  }
}
