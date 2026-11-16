import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { conflict, CRAFTPANEL_VERSION, notFound } from "@craftpanel/shared";
import { createZip, readZipEntry, sha256File } from "@craftpanel/backup";
import type { DatabaseHandle } from "@craftpanel/database";
import { freeDiskSpace } from "@craftpanel/server-runtime";
import { APP_BACKUP_FORMAT, APP_BACKUP_PREFIX, appBackupManifestSchema, formatEnvironment, type AppBackupManifest } from "../app-backup-format";
import type { AppConfig } from "../config";
import type { ActivityService, Actor } from "./activity";
import type { BackupService } from "./backups";
import type { ServerService } from "./servers";
import type { SettingsService } from "./settings";

export interface AppBackupInfo {
  filename: string;
  size: number;
  createdAt: number;
  /** Servers whose files are inside; null when the manifest could not be read. */
  servers: { total: number; withFiles: number } | null;
}

export interface AppBackupProgress { running: boolean; message: string | null; percent: number | null; error: string | null }

const NAME = new RegExp(`^${APP_BACKUP_PREFIX}[0-9T-]{1,30}(-config)?\\.zip$`);

/** Application backups: the panel's database and settings, optionally with every server's files, as one file. */
export class AppBackupService {
  private current: AppBackupProgress = { running: false, message: null, percent: null, error: null };

  constructor(
    private database: DatabaseHandle,
    private servers: ServerService,
    private backups: BackupService,
    private activity: ActivityService,
    private settings: SettingsService,
    private config: AppConfig,
  ) {}

  progress(): AppBackupProgress { return { ...this.current }; }

  private async directory() {
    const s = await this.settings.get();
    return path.join(s.backupDirectory || this.config.layout.backups, "application");
  }

  async list(): Promise<AppBackupInfo[]> {
    const dir = await this.directory();
    const out: AppBackupInfo[] = [];
    for (const filename of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!NAME.test(filename)) continue;
      const stat = await fsp.stat(path.join(dir, filename)).catch(() => null);
      if (!stat?.isFile()) continue;
      let servers: AppBackupInfo["servers"] = null;
      try {
        const manifest = appBackupManifestSchema.parse(JSON.parse((await readZipEntry(path.join(dir, filename), "manifest.json"))!.toString("utf8")));
        servers = { total: manifest.servers.length, withFiles: manifest.servers.filter((s) => s.archive).length };
      } catch { /* an unreadable manifest is shown without details */ }
      out.push({ filename, size: stat.size, createdAt: stat.mtimeMs, servers });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The file behind a listed name; anything else is refused so a request can't name another path. */
  async file(filename: string): Promise<string> {
    if (!NAME.test(filename)) throw notFound("Backup not found");
    const file = path.join(await this.directory(), filename);
    if (!(await fsp.stat(file).then((s) => s.isFile(), () => false))) throw notFound("Backup not found");
    return file;
  }

  async remove(filename: string, actor: Actor) {
    await fsp.rm(await this.file(filename));
    await this.activity.audit(actor, "app-backup.delete", null, { filename });
  }

  /** Starts the backup and returns at once; `progress()` shows how far it is. */
  start(includeServers: boolean, actor: Actor): void {
    if (this.current.running) throw conflict("An application backup is already running");
    this.current = { running: true, message: "Preparing", percent: null, error: null };
    void this.create(includeServers, actor).then(
      () => { this.current = { running: false, message: "Backup complete", percent: 100, error: null }; },
      (err: Error) => { this.current = { running: false, message: null, percent: null, error: err.message }; },
    );
  }

  private say(message: string, percent: number | null = null) { this.current = { ...this.current, message, percent }; }

  private async create(includeServers: boolean, actor: Actor): Promise<string> {
    const dir = await this.directory();
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const disk = await freeDiskSpace(dir);
    if (disk && disk.free < 512 * 1024 ** 2) throw new Error("Less than 512 MB free at the backup destination");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${APP_BACKUP_PREFIX}${stamp}${includeServers ? "" : "-config"}.zip`;
    const staging = path.join(this.config.layout.tmp, `app-backup-${crypto.randomBytes(6).toString("hex")}`);
    await fsp.mkdir(path.join(staging, "servers"), { recursive: true, mode: 0o700 });
    const temporary: string[] = []; // server backups made for this archive, removed afterwards
    try {
      this.say("Copying the database");
      const database = path.join(staging, "database.sqlite");
      this.database.raw.prepare("VACUUM INTO ?").run(database);

      const manifest: AppBackupManifest = {
        format: APP_BACKUP_FORMAT,
        createdAt: new Date().toISOString(),
        craftpanelVersion: CRAFTPANEL_VERSION,
        platform: process.platform,
        hostname: os.hostname(),
        database: { sha256: await sha256File(database) },
        config: null,
        tls: false,
        servers: [],
      };

      await fsp.mkdir(path.join(staging, "config"));
      const env = formatEnvironment(process.env);
      if (env.variables.length) {
        await fsp.writeFile(path.join(staging, "config", "environment.env"), env.text, { mode: 0o600 });
        manifest.config = { variables: env.variables };
      }
      const tls = this.config.tls;
      if (tls) {
        try {
          await fsp.copyFile(tls.certFile, path.join(staging, "config", "tls-cert.pem"));
          await fsp.copyFile(tls.keyFile, path.join(staging, "config", "tls-key.pem"));
          manifest.tls = true;
        } catch { /* the certificate files are not readable for this account: the backup goes without them */ }
      }

      const rows = await this.servers.rows();
      let done = 0;
      for (const row of rows) {
        let archive: string | null = null;
        if (includeServers && row.installState === "installed") {
          this.say(`Backing up ${row.name}`, Math.round((done / rows.length) * 90));
          const info = await this.backups.create(row.id, "application", actor, "Part of an application backup");
          temporary.push(info.id);
          const source = await this.backups.filePath(await this.backups.get(info.id));
          const target = path.join(staging, "servers", `${row.id}.zip`);
          // The same file system keeps this free: a hard link instead of a second copy of every world.
          await fsp.link(source, target).catch(() => fsp.copyFile(source, target));
          archive = `servers/${row.id}.zip`;
        }
        manifest.servers.push({ id: row.id, name: row.name, archive });
        done++;
      }
      await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

      this.say("Writing the archive", 90);
      const destination = path.join(dir, filename);
      await createZip({ sourceDir: staging, destination });
      await fsp.chmod(destination, 0o600);
      await this.activity.event(null, "app-backup.created", `Application backup created (${filename}${includeServers ? ", with server files" : ""})`, { actor });
      await this.activity.audit(actor, "app-backup.create", null, { filename, includeServers });
      return filename;
    } finally {
      for (const id of temporary) await this.backups.discard(id).catch(() => undefined);
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }
}
