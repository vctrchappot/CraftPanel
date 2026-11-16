import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { servers } from "@craftpanel/database";
import { listZip, readZipEntry } from "@craftpanel/backup";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { importApplicationBackup } from "../src/app-restore";
import { formatEnvironment } from "../src/app-backup-format";

describe("environment capture", () => {
  it("lists only CRAFTPANEL_ variables and quotes what a plain value cannot carry", () => {
    const { text, variables } = formatEnvironment({ CRAFTPANEL_PORT: "8080", CRAFTPANEL_PUBLIC_URL: "https://panel.example", CRAFTPANEL_NOTE: "a b\"c", CRAFTPANEL_EMPTY: "", PATH: "/usr/bin", HOME: "/root" });
    expect(variables).toEqual(["CRAFTPANEL_NOTE", "CRAFTPANEL_PORT", "CRAFTPANEL_PUBLIC_URL"]);
    expect(text).toBe('CRAFTPANEL_NOTE="a b\\"c"\nCRAFTPANEL_PORT=8080\nCRAFTPANEL_PUBLIC_URL=https://panel.example\n');
  });
});

describe("application backup and import", () => {
  let root: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let owner: { cookie: string; csrf: string };
  let id: string;
  let archive: string;
  const config = (dir: string) => ({ profile: "local" as const, host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json" as const, tls: null,
    layout: dataLayout(dir), corsOrigins: [], secureCookies: false, trustProxy: false as const, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
  const finished = async () => { for (let i = 0; i < 200; i++) { const p = ctx.appBackups.progress(); if (!p.running) return p; await new Promise((r) => setTimeout(r, 50)); } throw new Error("The backup did not finish"); };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-app-backup-"));
    const dir = path.join(root, "old", "servers", "alpha");
    await fsp.mkdir(path.join(dir, "world", "region"), { recursive: true });
    await fsp.writeFile(path.join(dir, "world", "level.dat"), "level-data");
    await fsp.writeFile(path.join(dir, "world", "region", "r.0.0.mca"), "region-data");
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=world\nserver-port=25599\n");
    await fsp.writeFile(path.join(dir, "server.jar"), "jar");
    ctx = await createContext(config(path.join(root, "old")));
    app = await buildApp(ctx, { logger: { level: "error", stream: { write: () => undefined } } });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
    owner = { cookie: String(setup.headers["set-cookie"]).split(";")[0]!, csrf: setup.json().csrfToken };
    id = crypto.randomUUID();
    const now = Date.now();
    await ctx.database.db.insert(servers).values({ id, name: "Alpha", software: "paper", mcVersion: "1.21.4", javaMajor: 21, javaPath: "C:\\old\\java.exe", memoryMb: 1024,
      directory: dir, port: 25599, bindAddress: "192.168.7.7", installState: "installed", eulaAccepted: true, jarFile: "server.jar", autoStart: true, lastStatus: "running", pid: 4242, createdAt: now, updatedAt: now });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    ctx?.database.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("restricts application backups to owners", async () => {
    expect((await app.inject({ method: "GET", url: "/api/app-backups" })).statusCode).toBe(401);
    await call("POST", "/api/users", { username: "viewer", password: "viewer-password-1", role: "viewer", serverScope: "all", serverRoles: {} });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password-1" } });
    const viewer = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": login.json().csrfToken };
    expect((await app.inject({ method: "GET", url: "/api/app-backups", headers: viewer })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/app-backups", payload: {}, headers: viewer })).statusCode).toBe(403);
  });

  it("writes the database, the settings and every server's files into one archive and leaves nothing behind", async () => {
    expect((await call("POST", "/api/app-backups", { includeServers: true })).statusCode).toBe(202);
    expect((await call("POST", "/api/app-backups", { includeServers: true })).statusCode).toBe(409);
    expect(await finished()).toMatchObject({ running: false, error: null });
    const list = (await call("GET", "/api/app-backups")).json().backups;
    expect(list).toHaveLength(1);
    expect(list[0].servers).toEqual({ total: 1, withFiles: 1 });
    archive = path.join(root, "old", "backups", "application", list[0].filename);
    expect((await listZip(archive)).map((e) => e.name).sort()).toEqual(["config/", "database.sqlite", "manifest.json", "servers/", `servers/${id}.zip`]);
    const manifest = JSON.parse((await readZipEntry(archive, "manifest.json"))!.toString("utf8"));
    expect(manifest).toMatchObject({ format: 1, tls: false, servers: [{ id, name: "Alpha", archive: `servers/${id}.zip` }] });
    // The server backup made for the archive is gone again; the staging folder too.
    expect((await call("GET", "/api/backups")).json()).toEqual([]);
    expect(await fsp.readdir(path.join(root, "old", "tmp"))).toEqual([]);
    const download = await call("GET", `/api/app-backups/${list[0].filename}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect((await call("GET", "/api/app-backups/..%2Fcraftpanel.db/download")).statusCode).toBe(404);
  }, 60_000);

  it("restores into a fresh data directory with new paths, no sessions and the game files marked for download", async () => {
    const fresh = path.join(root, "new");
    const result = await importApplicationBackup(dataLayout(fresh), archive);
    expect(result).toMatchObject({ servers: 1, withFiles: 1 });
    expect(result.notes.join("\n")).toContain("192.168.7.7");
    const target = path.join(fresh, "servers", id);
    expect(await fsp.readFile(path.join(target, "world", "region", "r.0.0.mca"), "utf8")).toBe("region-data");
    expect(JSON.parse(await fsp.readFile(path.join(target, ".craftpanel"), "utf8")).id).toBe(id);
    expect(JSON.parse(await fsp.readFile(path.join(fresh, "import", "reinstall.json"), "utf8"))).toEqual({ servers: [id] });
    const db = new DatabaseSync(path.join(fresh, "craftpanel.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT username FROM users").all()).toEqual([{ username: "owner" }, { username: "viewer" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT directory, java_path, pid, last_status, bind_address, auto_start FROM servers").get())
        .toEqual({ directory: target, java_path: null, pid: null, last_status: "stopped", bind_address: "", auto_start: 1 });
    } finally { db.close(); }
    // The restored panel opens: migrations apply and the owner can sign in again.
    const restored = await createContext(config(fresh));
    const second = await buildApp(restored, { logger: { level: "error", stream: { write: () => undefined } } });
    try {
      expect((await second.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "owner-password-1" } })).statusCode).toBe(200);
      expect((await restored.servers.rows())[0]!.directory).toBe(target);
    } finally { await second.close(); restored.database.close(); }
  }, 60_000);

  it("does not replay an empty installation's abandoned WAL over the imported accounts", async () => {
    const fresh = path.join(root, "abruptly-stopped");
    const empty = await createContext(config(fresh));
    empty.database.close();
    const layout = dataLayout(fresh);
    // Like Stop-ScheduledTask: terminate without SQLite's close/checkpoint. The last WAL pages have no owner.
    spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; VACUUM;");
      db.exec("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('temporary', 'temporary', 'unused', 'owner', 1); DELETE FROM users;");
      process.kill(process.pid, 'SIGKILL');
    `, layout.database], { windowsHide: true, timeout: 10_000 });
    expect((await fsp.stat(layout.database + "-wal")).size).toBeGreaterThan(32);
    await importApplicationBackup(layout, archive);
    const restored = await createContext(config(fresh));
    const second = await buildApp(restored, { logger: false });
    try {
      expect((await second.inject({ method: "GET", url: "/api/auth/state" })).json().setupRequired).toBe(false);
      expect((await second.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "owner-password-1" } })).statusCode).toBe(200);
    } finally { await second.close(); restored.database.close(); }
  }, 60_000);

  it("refuses to overwrite an installation with data unless told to, and keeps what it moves aside", async () => {
    const fresh = path.join(root, "new");
    await expect(importApplicationBackup(dataLayout(fresh), archive)).rejects.toThrow(/already has an owner account/);
    await importApplicationBackup(dataLayout(fresh), archive, { replace: true });
    expect((await fsp.readdir(fresh)).some((n) => n.startsWith("craftpanel.db.before-import-"))).toBe(true);
    expect((await fsp.readdir(path.join(fresh, "servers"))).some((n) => n.startsWith(`${id}.before-import-`))).toBe(true);
  }, 60_000);

  it("rejects archives that are damaged, foreign or from a newer CraftPanel", async () => {
    const empty = dataLayout(path.join(root, "never"));
    const damaged = path.join(root, "damaged.zip");
    await fsp.writeFile(damaged, "not a zip");
    await expect(importApplicationBackup(empty, damaged)).rejects.toThrow(/damaged/);
    await expect(importApplicationBackup(empty, path.join(root, "missing.zip"))).rejects.toThrow(/No such file/);
    await fsp.access(path.join(root, "never", "craftpanel.db")).then(() => { throw new Error("created a database"); }, () => undefined);
  });
});
