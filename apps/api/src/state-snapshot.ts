import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface SnapshotManifest {
  format: 1;
  source: string;
  database: null | { sha256: string; uid: number; gid: number; mode: number };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_JSON_SIZE = 64 * 1024;

/** Hold the opened inode throughout every privileged read; never follow a source symlink. */
async function openRegular(file: string): Promise<FileHandle> {
  const before = await fs.lstat(file);
  if (!before.isFile()) throw new Error(`Expected a regular file: ${file}`);
  const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW);
  const opened = await handle.stat();
  if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
    await handle.close();
    throw new Error(`File changed while opening: ${file}`);
  }
  return handle;
}

async function readJson(file: string): Promise<unknown> {
  const handle = await openRegular(file);
  try {
    if ((await handle.stat()).size > MAX_JSON_SIZE) throw new Error(`Recovery metadata is too large: ${file}`);
    // Do not include a potentially sensitive file's contents in a JSON parser error.
    try { return JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error(`Invalid recovery metadata: ${file}`); }
  } finally { await handle.close(); }
}

async function copyToHandle(source: FileHandle, target: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(buffer, written, bytesRead - written, position + written);
      if (!result.bytesWritten) throw new Error("Could not write the database recovery file");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return; // Windows does not expose fsync on directory handles.
  const handle = await fs.open(directory, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertStopped(dataDir: string): Promise<void> {
  let control: unknown;
  try { control = await readJson(path.join(dataDir, "control.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const pid = control && typeof control === "object" ? (control as { pid?: unknown }).pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff)
    throw new Error("Invalid control file; verify CraftPanel is stopped first");
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  throw new Error("CraftPanel is still running; stop it before snapshot or restore");
}

async function dataDirectory(input: string): Promise<string> {
  const directory = await fs.realpath(path.resolve(input));
  if (!(await fs.stat(directory)).isDirectory()) throw new Error("The CraftPanel data path must be a directory");
  return directory;
}

async function copyRegular(source: string, destination: string, optionalSource = false): Promise<{ hash: string; stat: Stats } | undefined> {
  let input: FileHandle;
  try { input = await openRegular(source); }
  catch (error) { if (optionalSource && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let output: FileHandle | undefined;
  try {
    const stat = await input.stat();
    output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const hash = await copyToHandle(input, output);
    const after = await input.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw new Error("Database state changed during the snapshot; confirm all application processes are stopped");
    await output.sync();
    return { hash, stat };
  } finally { await output?.close(); await input.close(); }
}

/** The installer must confirm OS-level process quiescence; a missing control file alone cannot prove it. */
export async function snapshotState(dataDir: string, destination: string): Promise<void> {
  const source = await dataDirectory(dataDir);
  const requested = path.resolve(destination);
  const dir = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  if (dir === source || dir.startsWith(source + path.sep)) throw new Error("Update snapshots must be outside the data directory");
  await assertStopped(source);
  await fs.mkdir(dir, { mode: 0o700 }); // Never overwrite an existing recovery point.
  const manifest: SnapshotManifest = { format: 1, source, database: null };
  const file = path.join(source, "craftpanel.db");
  const staged = path.join(dir, "source.sqlite");
  const copied = await copyRegular(file, staged, true);
  if (copied) {
    // SQLite operates only on the private copy: no root-created SHM files in service-writable paths.
    await copyRegular(file + "-wal", staged + "-wal", true);
    const target = path.join(dir, "database.sqlite");
    const db = new DatabaseSync(staged, { readOnly: true });
    try { db.prepare("VACUUM INTO ?").run(target); } finally { db.close(); }
    const targetHandle = await openRegular(target);
    let hash: string;
    try {
      const contents = createHash("sha256");
      for await (const chunk of targetHandle.createReadStream({ autoClose: false })) contents.update(chunk);
      hash = contents.digest("hex");
    } finally { await targetHandle.close(); }
    // This path is in the private installer-owned snapshot directory, never in the service data dir.
    const writable = await fs.open(target, constants.O_RDWR | NOFOLLOW);
    try { await writable.chmod(0o600); await writable.sync(); } finally { await writable.close(); }
    manifest.database = { sha256: hash, uid: copied.stat.uid, gid: copied.stat.gid, mode: copied.stat.mode & 0o777 };
    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(staged + suffix, { force: true });
  }
  const manifestHandle = await fs.open(path.join(dir, "manifest.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { await manifestHandle.writeFile(JSON.stringify(manifest) + "\n"); await manifestHandle.sync(); }
  finally { await manifestHandle.close(); }
  await syncDirectory(dir);
  await syncDirectory(path.dirname(dir));
}

function parseManifest(value: unknown, source: string): SnapshotManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid update snapshot manifest");
  const manifest = value as Partial<SnapshotManifest>;
  if (manifest.format !== 1 || manifest.source !== source)
    throw new Error("Invalid update snapshot, or snapshot belongs to another data directory");
  if (manifest.database !== null) {
    const db = manifest.database;
    if (!db || typeof db !== "object" || typeof db.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(db.sha256) ||
        ![db.uid, db.gid].every((n) => Number.isInteger(n) && n >= 0 && n < 0xffffffff) ||
        !Number.isInteger(db.mode) || db.mode < 0 || db.mode > 0o777)
      throw new Error("Invalid update snapshot manifest");
  }
  return manifest as SnapshotManifest;
}

/** Restore only the panel database, never worlds. The installer must first confirm all processes stopped. */
export async function restoreState(dataDir: string, snapshot: string): Promise<void> {
  const source = await dataDirectory(dataDir);
  await assertStopped(source);
  const dir = await fs.realpath(path.resolve(snapshot));
  const manifest = parseManifest(await readJson(path.join(dir, "manifest.json")), source);
  const file = path.join(source, "craftpanel.db");
  let temp: string | undefined;
  let output: FileHandle | undefined;
  try {
    if (manifest.database) {
      const input = await openRegular(path.join(dir, "database.sqlite"));
      try {
        temp = path.join(source, `.craftpanel-restore-${randomUUID()}`);
        output = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        if (await copyToHandle(input, output) !== manifest.database.sha256)
          throw new Error("Update snapshot checksum mismatch; refusing to restore");
        await output.chmod(manifest.database.mode & 0o700);
        if (process.platform !== "win32") await output.chown(manifest.database.uid, manifest.database.gid);
        await output.sync();
        const inode = await output.stat();
        const named = await fs.lstat(temp);
        if (!named.isFile() || named.dev !== inode.dev || named.ino !== inode.ino)
          throw new Error("Database recovery file was replaced; refusing to restore");
      } finally { await input.close(); }
    }
    // Never reuse WAL from the failed version with the previous database.
    for (const suffix of ["-wal", "-shm"]) await fs.rm(file + suffix, { force: true });
    // Windows requires the restore handle to be closed before replacement.
    await output?.close(); output = undefined;
    if (temp) { await fs.rename(temp, file); temp = undefined; }
    else await fs.rm(file, { force: true });
    await syncDirectory(source);
  } finally { await output?.close(); if (temp) await fs.rm(temp, { force: true }); }
}
