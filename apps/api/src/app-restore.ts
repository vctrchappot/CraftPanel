import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CRAFTPANEL_VERSION } from "@craftpanel/shared";
import { extractZip, readZipEntry, sha256File, verifyZip } from "@craftpanel/backup";
import { RuntimeClient, type DataLayout } from "@craftpanel/server-runtime";
import { appBackupManifestSchema } from "./app-backup-format";
import { compareVersions } from "./services/updates";

const MARKER = ".craftpanel";
/** Bind addresses that mean the same on every computer; any other is an address of the old host. */
const PORTABLE_BIND = new Set(["", "127.0.0.1", "0.0.0.0", "::", "::1", "localhost"]);

export interface ImportResult {
  servers: number;
  withFiles: number;
  /** Where the old settings and certificate were put, for the person to apply. */
  importDir: string;
  notes: string[];
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

/** Opens a SQLite file and runs `fn`; the file is closed afterwards. */
function withDatabase<T>(file: string, readOnly: boolean, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly });
  try { return fn(db); } finally { db.close(); }
}

const tableExists = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

async function assertStopped(layout: DataLayout) {
  const client = new RuntimeClient(layout.root, () => undefined);
  try {
    await client.connect();
    if (client.connected) throw new Error("The Minecraft runtime is running; stop it (and with it the servers) before importing a backup");
  } catch (err) {
    if ((err as Error).message.includes("runtime is running")) throw err;
  } finally { await client.disconnect(); }
  try {
    const { pid } = JSON.parse(await fsp.readFile(path.join(layout.root, "control.json"), "utf8")) as { pid?: number };
    if (Number.isInteger(pid) && pid! > 0) {
      try { process.kill(pid!, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") return; }
      throw new Error("CraftPanel is running; stop it before importing a backup");
    }
  } catch (err) {
    if ((err as Error).message.includes("CraftPanel is running")) throw err;
  }
}

/**
 * Restores an application backup into a data directory while CraftPanel and its runtime are stopped:
 * the database, every server's files and worlds under this data directory's `servers/`, and the old
 * settings and certificate under `import/` (they belong to the old host, so nothing applies them on its own).
 * The game files themselves are downloaded again at the next start (`import/reinstall.json`).
 */
export async function importApplicationBackup(layout: DataLayout, archive: string, opts: { replace?: boolean; log?: (message: string) => void } = {}): Promise<ImportResult> {
  const log = opts.log ?? (() => undefined);
  const file = path.resolve(archive);
  if (!(await exists(file))) throw new Error(`No such file: ${file}`);
  await assertStopped(layout);

  log("Checking the archive");
  const check = await verifyZip(file);
  if (!check.ok) throw new Error(`The backup is damaged: ${check.error}`);
  const raw = await readZipEntry(file, "manifest.json");
  if (!raw) throw new Error("This is not an application backup (no manifest.json)");
  const parsed = appBackupManifestSchema.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success) throw new Error("This backup is not in a format this CraftPanel understands");
  const manifest = parsed.data;
  if (compareVersions(manifest.craftpanelVersion, CRAFTPANEL_VERSION) > 0)
    throw new Error(`The backup was made by CraftPanel ${manifest.craftpanelVersion}, which is newer than this ${CRAFTPANEL_VERSION}. Update CraftPanel first.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const notes: string[] = [];
  const hasData = (await exists(layout.database)) && withDatabase(layout.database, true, (db) => tableExists(db, "users") && !!db.prepare("SELECT 1 FROM users LIMIT 1").get());
  if (hasData && !opts.replace) throw new Error("This installation already has an owner account and data. Import into a fresh data directory, or pass --replace to move the current data aside first.");
  const targets = manifest.servers.map((s) => path.join(layout.servers, s.id));
  for (const target of targets) {
    if ((await exists(target)) && !opts.replace) throw new Error(`${target} already exists; pass --replace to move it aside`);
  }

  await fsp.mkdir(layout.root, { recursive: true });
  const staging = path.join(layout.root, `import-staging-${crypto.randomBytes(6).toString("hex")}`);
  const created: string[] = [];
  try {
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
    await extractZip({ file, destination: staging, filter: (name) => !name.startsWith("servers/") });
    const database = path.join(staging, "database.sqlite");
    if ((await sha256File(database)) !== manifest.database.sha256) throw new Error("The database in the backup does not match its manifest");

    // Edit the copy, never the live database: paths and states of the old host are meaningless here.
    const reinstall: string[] = [];
    const result = withDatabase(database, false, (db) => {
      db.exec("BEGIN");
      try {
        const ids = new Set(manifest.servers.map((s) => s.id));
        const rows = (tableExists(db, "servers") ? db.prepare("SELECT id, name, bind_address FROM servers").all() : []) as { id: string; name: string; bind_address: string }[];
        for (const row of rows) {
          if (!ids.has(row.id)) throw new Error(`The database lists a server (${row.id}) that the manifest does not`);
          db.prepare("UPDATE servers SET directory = ?, java_path = NULL, pid = NULL, started_at = NULL, last_status = 'stopped', desired_running = 0, last_error = NULL WHERE id = ?")
            .run(path.join(layout.servers, row.id), row.id);
          if (!PORTABLE_BIND.has(row.bind_address)) {
            db.prepare("UPDATE servers SET bind_address = '' WHERE id = ?").run(row.id);
            notes.push(`${row.name}: the address ${row.bind_address} belonged to the old computer; the server listens on every address now (Settings → Network).`);
          }
        }
        if (tableExists(db, "sessions")) db.exec("DELETE FROM sessions");
        // A scheduled application backup snapshots its own unfinished run. It cannot resume on this host.
        if (tableExists(db, "schedule_runs")) db.prepare("UPDATE schedule_runs SET status = 'failed', finished_at = ?, output = 'Interrupted by application backup import' WHERE status = 'running'").run(Date.now());
        if (tableExists(db, "backups")) {
          const n = (db.prepare("SELECT COUNT(*) AS n FROM backups").get() as { n: number }).n;
          db.exec("DELETE FROM backups");
          if (n) notes.push(`${n} earlier server backups are not part of an application backup; their list starts empty.`);
        }
        if (tableExists(db, "app_settings")) {
          const custom = db.prepare("SELECT 1 FROM app_settings WHERE key = 'backupDirectory'").get();
          db.exec("DELETE FROM app_settings WHERE key = 'backupDirectory'");
          if (custom) notes.push("The backup folder of the old computer is not used here; choose one under Settings → Backups.");
        }
        db.exec("COMMIT");
        return rows.length;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    });

    if (opts.replace) {
      for (const suffix of ["", "-wal", "-shm"]) if (await exists(layout.database + suffix)) await fsp.rename(layout.database + suffix, `${layout.database}${suffix}.before-import-${stamp}`);
    }

    await fsp.mkdir(layout.servers, { recursive: true });
    let withFiles = 0;
    for (const server of manifest.servers) {
      const target = path.join(layout.servers, server.id);
      if (opts.replace && (await exists(target))) await fsp.rename(target, `${target}.before-import-${stamp}`);
      if (server.archive) {
        log(`Restoring ${server.name}`);
        await extractZip({ file, destination: staging, filter: (name) => name === server.archive });
        const inner = path.join(staging, server.archive);
        const partial = `${target}.importing`;
        await fsp.rm(partial, { recursive: true, force: true });
        await extractZip({ file: inner, destination: partial });
        await fsp.rm(inner);
        await fsp.rename(partial, target);
        withFiles++;
      } else {
        await fsp.mkdir(target, { recursive: true });
        notes.push(`${server.name}: the backup has no files for this server; its game files are installed again and the world starts empty.`);
      }
      created.push(target);
      await fsp.writeFile(path.join(target, MARKER), JSON.stringify({ id: server.id, createdAt: new Date().toISOString(), importedAt: new Date().toISOString() }));
      reinstall.push(server.id);
    }

    // The database goes in last: until then a failed import leaves the data directory as it was.
    const final = `${layout.database}.importing`;
    await fsp.copyFile(database, final);
    await fsp.chmod(final, 0o600);
    await fsp.rename(final, layout.database);

    const importDir = path.join(layout.root, "import");
    await fsp.mkdir(importDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(importDir, "reinstall.json"), JSON.stringify({ servers: reinstall }), { mode: 0o600 });
    for (const name of ["environment.env", "tls-cert.pem", "tls-key.pem"]) {
      const source = path.join(staging, "config", name);
      if (await exists(source)) await fsp.copyFile(source, path.join(importDir, name)).then(() => fsp.chmod(path.join(importDir, name), 0o600));
    }
    if (manifest.config) notes.push(`The old settings are in ${path.join(importDir, "environment.env")}: copy what still applies (port, profile, public address) into this installation's settings file. Paths in it belong to the old computer.`);
    if (manifest.tls) notes.push(`The old HTTPS certificate and key are in ${importDir}.`);
    if (manifest.platform !== process.platform) notes.push(`The backup comes from ${manifest.platform}; this computer runs ${process.platform}. Servers install their game files again, so this works, but custom Java paths and scripts do not carry over.`);
    return { servers: result, withFiles, importDir, notes };
  } catch (err) {
    for (const dir of created) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
