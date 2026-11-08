import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotState, restoreState } from "../src/state-snapshot";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-state-"));
  roots.push(root);
  const data = path.join(root, "data");
  await fs.mkdir(data);
  return { root, data, snapshot: path.join(root, "snapshot"), file: path.join(data, "craftpanel.db") };
}
function initialize(file: string) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE settings (value TEXT); INSERT INTO settings VALUES ('original');");
  db.close();
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("update database recovery", () => {
  it("refuses to change state while the recorded application process is alive", async () => {
    const { data, snapshot } = await fixture();
    await fs.writeFile(path.join(data, "control.json"), JSON.stringify({ pid: process.pid }));
    await expect(snapshotState(data, snapshot)).rejects.toThrow(/still running/);
    await expect(restoreState(data, snapshot)).rejects.toThrow(/still running/);
  });

  it("refuses a separate live process and invalid control metadata", async () => {
    const { data, snapshot } = await fixture();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    await once(child, "spawn");
    try {
      await fs.writeFile(path.join(data, "control.json"), JSON.stringify({ pid: child.pid }));
      await expect(snapshotState(data, snapshot)).rejects.toThrow(/still running/);
    } finally { child.stdin.end(); await once(child, "exit"); }
    for (const value of [null, {}, { pid: -1 }, { pid: "123" }, { pid: 1.1 }]) {
      await fs.writeFile(path.join(data, "control.json"), JSON.stringify(value));
      await expect(snapshotState(data, snapshot)).rejects.toThrow(/Invalid control/);
    }
  });

  it("restores data and schema after a failing migration without changing worlds", async () => {
    const { data, snapshot, file } = await fixture();
    initialize(file);
    await fs.writeFile(path.join(data, "world.dat"), "world-data");
    await snapshotState(data, snapshot);
    let db = new DatabaseSync(file);
    db.exec("ALTER TABLE settings ADD COLUMN incompatible TEXT; UPDATE settings SET value='changed';");
    db.close();
    await restoreState(data, snapshot);
    db = new DatabaseSync(file);
    try {
      expect(db.prepare("SELECT * FROM settings").all()).toEqual([{ value: "original" }]);
      expect(db.prepare("PRAGMA table_info(settings)").all()).toHaveLength(1);
    } finally { db.close(); }
    expect(await fs.readFile(path.join(data, "world.dat"), "utf8")).toBe("world-data");
  });

  it("includes committed WAL contents without modifying the original DB or sidecars", async () => {
    const { data, snapshot, file } = await fixture();
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (id INTEGER); INSERT INTO events VALUES (42);");
      expect((await fs.stat(file + "-wal")).size).toBeGreaterThan(0);
      const before = await Promise.all(["", "-wal", "-shm"].map((suffix) => fs.readFile(file + suffix)));
      await snapshotState(data, snapshot);
      for (let i = 0; i < before.length; i++) expect(await fs.readFile(file + ["", "-wal", "-shm"][i])).toEqual(before[i]);
    } finally { db.close(); }
    await restoreState(data, snapshot);
    const restored = new DatabaseSync(file);
    try { expect(restored.prepare("SELECT id FROM events").get()?.id).toBe(42); } finally { restored.close(); }
    expect((await fs.readdir(snapshot)).sort()).toEqual(["database.sqlite", "manifest.json"]);
  });

  it("refuses damaged or mismatched recovery points before touching the current database", async () => {
    const { data, snapshot, file } = await fixture();
    initialize(file);
    await snapshotState(data, snapshot);
    const before = await fs.readFile(file);
    await fs.mkdir(data + "-other");
    await expect(restoreState(data + "-other", snapshot)).rejects.toThrow(/another data directory/);
    await fs.appendFile(path.join(snapshot, "database.sqlite"), "damaged");
    await expect(restoreState(data, snapshot)).rejects.toThrow(/checksum/);
    expect(await fs.readFile(file)).toEqual(before);
    await expect(snapshotState(data, snapshot)).rejects.toThrow();
  });

  it("rejects malformed manifests before touching data or WAL sidecars", async () => {
    const { data, snapshot, file } = await fixture();
    initialize(file);
    await snapshotState(data, snapshot);
    const manifestFile = path.join(snapshot, "manifest.json");
    const valid = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const before = await fs.readFile(file);
    for (const value of [null, [], {}, { ...valid, database: {} }, { ...valid, database: "absent" },
      { ...valid, database: { ...valid.database, mode: 0o1000 } },
      { ...valid, database: { ...valid.database, uid: -1 } },
      { ...valid, database: { ...valid.database, gid: 1.1 } },
      { ...valid, database: { ...valid.database, sha256: "not a hash" } }]) {
      await fs.writeFile(manifestFile, JSON.stringify(value));
      await expect(restoreState(data, snapshot)).rejects.toThrow(/Invalid update snapshot/);
      expect(await fs.readFile(file)).toEqual(before);
    }
  });

  it("uses held handles rather than path-based metadata operations in the data directory", async () => {
    const { data, snapshot, file } = await fixture();
    initialize(file);
    await snapshotState(data, snapshot);
    const chmod = vi.spyOn(fs, "chmod");
    const chown = vi.spyOn(fs, "chown");
    await restoreState(data, snapshot);
    expect(chmod).not.toHaveBeenCalled();
    expect(chown).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("cannot chmod/chown a victim through a swapped temporary symlink", async () => {
    const { root, data, snapshot, file } = await fixture();
    initialize(file);
    await snapshotState(data, snapshot);
    const victim = path.join(root, "victim.txt");
    await fs.writeFile(victim, "must remain intact", { mode: 0o644 });
    const beforeDatabase = await fs.readFile(file);
    const beforeMode = (await fs.stat(victim)).mode;
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const filePath = String(args[0]);
      if (path.basename(filePath).startsWith(".craftpanel-restore-")) {
        const originalChmod = handle.chmod.bind(handle);
        handle.chmod = async (mode) => {
          await fs.unlink(filePath);
          await fs.symlink(victim, filePath);
          return originalChmod(mode);
        };
      }
      return handle;
    });
    await expect(restoreState(data, snapshot)).rejects.toThrow(/replaced/);
    expect((await fs.stat(victim)).mode).toBe(beforeMode);
    expect(await fs.readFile(victim, "utf8")).toBe("must remain intact");
    expect(await fs.readFile(file)).toEqual(beforeDatabase);
  });

  it("rejects nonregular database sources and recovery destinations inside the data directory", async () => {
    const { data, snapshot, file } = await fixture();
    await fs.mkdir(file);
    await expect(snapshotState(data, snapshot)).rejects.toThrow(/regular file/);
    await expect(snapshotState(data, path.join(data, "snapshot"))).rejects.toThrow(/outside/);
  });

  it.skipIf(process.platform === "win32")("rejects symlinked databases and WAL files before SQLite can open them", async () => {
    const { root, data, snapshot, file } = await fixture();
    const victim = path.join(root, "victim.sqlite");
    initialize(victim);
    await fs.symlink(victim, file);
    await expect(snapshotState(data, snapshot)).rejects.toThrow(/regular file/);
    await fs.unlink(file);
    initialize(file);
    await fs.symlink(victim, file + "-wal");
    await expect(snapshotState(data, snapshot + "-wal")).rejects.toThrow(/regular file/);
    const db = new DatabaseSync(victim);
    try { expect(db.prepare("SELECT value FROM settings").get()?.value).toBe("original"); } finally { db.close(); }
  });

  it("can restore the absence of a database and removes stale WAL sidecars", async () => {
    const { data, snapshot, file } = await fixture();
    await snapshotState(data, snapshot);
    const db = new DatabaseSync(file); db.exec("CREATE TABLE unwanted (id INTEGER)"); db.close();
    await fs.writeFile(file + "-wal", "stale"); await fs.writeFile(file + "-shm", "stale");
    await restoreState(data, snapshot);
    for (const suffix of ["", "-wal", "-shm"]) await expect(fs.access(file + suffix)).rejects.toThrow();
  });
});
