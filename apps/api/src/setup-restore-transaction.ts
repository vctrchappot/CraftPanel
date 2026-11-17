import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DataLayout } from "@craftpanel/server-runtime";

export interface RestoreTransfer { from: string; to: string; replace?: boolean }
interface Journal { version: 1; pid: number; phase: "activating" | "committed"; transfers: RestoreTransfer[] }
const exists = (file: string) => fsp.access(file).then(() => true, () => false);
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };

export async function createRestoreWorkspace(layout: DataLayout) {
  const work = path.join(layout.root, `setup-restore-${crypto.randomBytes(16).toString("hex")}`);
  await fsp.mkdir(work, { mode: 0o700 });
  await fsp.writeFile(path.join(work, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return work;
}

export async function writeRestoreJournal(work: string, transfers: RestoreTransfer[], phase: Journal["phase"]) {
  const temporary = path.join(work, "transaction.tmp");
  const file = await fsp.open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, pid: process.pid, phase, transfers } satisfies Journal)); await file.sync(); }
  finally { await file.close(); }
  await fsp.rename(temporary, path.join(work, "transaction.json"));
}

/** Infer completed atomic renames from a write-ahead plan, including a crash between two renames. */
export async function rollbackRestore(work: string, transfers: RestoreTransfer[], database: string) {
  // These sidecars belong to the newly opened database, never to the saved original.
  // A killed process may leave committed writes there before activation is marked committed.
  if (transfers.some((move) => move.to === database))
    for (const suffix of ["-wal", "-shm"]) await fsp.rm(database + suffix, { force: true });
  const errors: unknown[] = [];
  for (let index = transfers.length - 1; index >= 0; index--) {
    const move = transfers[index]!;
    const old = path.join(work, "previous", String(index));
    try {
      if (!await exists(move.from) && await exists(move.to)) await fsp.rename(move.to, move.from);
      if (await exists(old)) {
        if (await exists(move.to)) throw new Error(`Cannot roll back over an existing destination: ${move.to}`);
        await fsp.rename(old, move.to);
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `Restore recovery files are kept in ${work}`);
}

/** Called before opening SQLite. Never discard an incomplete activation's recovery files. */
export async function recoverSetupRestores(layout: DataLayout) {
  for (const name of await fsp.readdir(layout.root).catch(() => [] as string[])) {
    if (!/^setup-restore-[a-f0-9]{32}$/.test(name)) continue;
    const work = path.join(layout.root, name);
    if (!(await fsp.lstat(work)).isDirectory() || (await fsp.lstat(work)).isSymbolicLink()) throw new Error("Unsafe setup restore workspace");
    const owner = JSON.parse(await fsp.readFile(path.join(work, "owner.json"), "utf8")) as { pid: number };
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid setup restore owner");
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error("First-run restoration is already running in another CraftPanel process");
    const file = path.join(work, "transaction.json");
    if (await exists(file)) {
      const journal = JSON.parse(await fsp.readFile(file, "utf8")) as Journal;
      if (journal.version !== 1 || !["activating", "committed"].includes(journal.phase) || !Array.isArray(journal.transfers) || journal.transfers.length > 2005)
        throw new Error("Invalid setup restore journal; recovery files were kept");
      for (const move of journal.transfers) {
        if (typeof move.from !== "string" || typeof move.to !== "string" || !within(path.join(work, "staged"), move.from) ||
            !(move.to === layout.database || move.to === path.join(layout.root, "import") || within(layout.servers, move.to) || within(layout.backups, move.to)))
          throw new Error("Unsafe setup restore journal; recovery files were kept");
      }
      if (journal.phase === "activating") await rollbackRestore(work, journal.transfers, layout.database);
    }
    await fsp.rm(work, { recursive: true, force: true });
  }
}
