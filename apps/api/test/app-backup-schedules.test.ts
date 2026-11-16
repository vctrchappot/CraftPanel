import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { scheduleSchema } from "@craftpanel/shared";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { importApplicationBackup } from "../src/app-restore";

describe("scheduled application backups", () => {
  let root: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  const sessions: Record<string, { cookie: string; "x-csrf-token": string }> = {};
  const actor = { id: null, username: "owner" };
  const input = (extra: object = {}) => scheduleSchema.parse({ name: "Nightly panel", cron: "0 4 * * *", action: "application-backup", payload: { includeServers: false, keep: 2 }, enabled: false, ...extra });
  const call = (user: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: sessions[user] });
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-scheduled-app-"));
    ctx = await createContext({ profile: "local", host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json", tls: null, layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
    app = await buildApp(ctx, { logger: false });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
    sessions.owner = { cookie: String(setup.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": setup.json().csrfToken };
    for (const role of ["admin", "operator", "viewer"]) {
      expect((await call("owner", "POST", "/api/users", { username: role, password: `${role}-password-1`, role, serverScope: "all", serverRoles: {} })).statusCode).toBe(200);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: role, password: `${role}-password-1` } });
      sessions[role] = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": login.json().csrfToken };
    }
  });
  afterAll(async () => { ctx?.schedules.stop(); await app?.close(); ctx?.database.close(); await fs.rm(root, { recursive: true, force: true }); });

  it("restricts every operation, including changing a server schedule into an application backup, to the owner", async () => {
    const created = await call("owner", "POST", "/api/schedules", input());
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    for (const role of ["admin", "operator", "viewer"]) {
      expect((await call(role, "POST", "/api/schedules", input())).statusCode).toBe(403);
      expect((await call(role, "GET", "/api/schedules")).json().some((s: { id: string }) => s.id === id)).toBe(false);
      expect((await call(role, "GET", `/api/schedules/${id}/runs`)).statusCode).toBe(403);
      expect((await call(role, "POST", `/api/schedules/${id}/run`)).statusCode).toBe(403);
      expect((await call(role, "PUT", `/api/schedules/${id}`, input())).statusCode).toBe(403);
      expect((await call(role, "PUT", `/api/schedules/${id}`, input({ action: "start", serverId: "fake" }))).statusCode).toBe(403);
      expect((await call(role, "DELETE", `/api/schedules/${id}`)).statusCode).toBe(403);
    }
    const ordinary = await ctx.schedules.create(input({ action: "start", serverId: null }), actor).catch(() => null);
    expect(ordinary).toBeNull();
    // Create a global legacy schedule directly: its old permission is not enough to change its kind.
    const { schedules } = await import("@craftpanel/database");
    const legacyId = crypto.randomUUID();
    await ctx.database.db.insert(schedules).values({ id: legacyId, name: "Legacy", cron: "0 4 * * *", action: "start", payload: "{}", enabled: false, createdAt: Date.now() });
    expect((await call("admin", "PUT", `/api/schedules/${legacyId}`, input())).statusCode).toBe(403);
    expect((await call("owner", "POST", "/api/schedules", input({ serverId: "fake" }))).statusCode).toBe(400);
    expect((await call("owner", "PUT", `/api/schedules/${id}`, input({ cron: "invalid" }))).statusCode).toBe(400);
    expect((await call("owner", "PUT", `/api/schedules/${id}`, { ...input(), payload: { keep: 0 } })).statusCode).toBe(400);
    await call("owner", "DELETE", `/api/schedules/${id}`);
    await call("owner", "DELETE", `/api/schedules/${legacyId}`);
  });

  it("keeps the newest N successful archives per schedule and preserves manual backups and other schedules", async () => {
    const manual = await ctx.appBackups.run(false, actor);
    const first = await ctx.schedules.create(input(), actor);
    const other = await ctx.schedules.create(input({ name: "Weekly" }), actor);
    await ctx.schedules.runNow(other.id, actor);
    for (let i = 0; i < 3; i++) await ctx.schedules.runNow(first.id, actor);
    const files = await ctx.appBackups.list();
    expect(files.filter((b) => b.scheduleId === first.id)).toHaveLength(2);
    expect(files.filter((b) => b.scheduleId === other.id)).toHaveLength(1);
    expect(files.find((b) => b.filename === manual)?.scheduleId).toBeNull();
    expect((await ctx.schedules.runs(first.id)).map((r) => r.status)).toEqual(["success", "success", "success"]);
    const imported = dataLayout(path.join(root, "imported"));
    await importApplicationBackup(imported, path.join(root, "backups", "application", files.find((b) => b.scheduleId === first.id)!.filename));
    const restoredDb = new DatabaseSync(imported.database, { readOnly: true });
    try {
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
      expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE output = 'Interrupted by application backup import'").get()).toEqual({ n: 1 });
    } finally { restoredDb.close(); }
    const before = files.map((b) => b.filename).sort();
    const blocked = path.join(root, "blocked");
    await fs.writeFile(blocked, "not a directory");
    await ctx.settings.set({ backupDirectory: blocked });
    await ctx.schedules.runNow(first.id, actor);
    expect((await ctx.schedules.runs(first.id))[0]).toMatchObject({ status: "failed" });
    expect((await ctx.activity.list({})).some((e) => e.kind === "app-backup.failed" && e.level === "error")).toBe(true);
    await ctx.settings.set({ backupDirectory: "" });
    expect((await ctx.appBackups.list()).map((b) => b.filename).sort()).toEqual(before);
    await ctx.schedules.remove(first.id, actor);
    expect((await ctx.appBackups.list()).map((b) => b.filename).sort()).toEqual(before);
    await ctx.schedules.remove(other.id, actor);
  });

  it("waits for completion, prevents manual overlap and skips a scheduled run while another backup holds the lock", async () => {
    const schedule = await ctx.schedules.create(input(), actor);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const waiting = new Promise<void>((r) => { entered = r; });
    // Hold the server list step, after the database snapshot has been made.
    const rows = vi.spyOn(ctx.servers, "rows").mockImplementationOnce(async () => { entered(); await gate; return []; });
    const backup = ctx.appBackups.run(false, actor);
    await waiting;
    try {
      expect(ctx.appBackups.progress().running).toBe(true);
      expect(() => ctx.appBackups.start(false, actor)).toThrow(/already running/);
      await ctx.schedules.runNow(schedule.id, actor);
      expect((await ctx.schedules.runs(schedule.id))[0]).toMatchObject({ status: "skipped" });
    } finally { release(); await backup; rows.mockRestore(); }
    expect(ctx.appBackups.progress()).toMatchObject({ running: false, error: null });
    await ctx.schedules.remove(schedule.id, actor);
  });

  it("prunes only the destination used by the new archive when settings change during the backup", async () => {
    const schedule = { id: crypto.randomUUID(), keep: 1 };
    const oldDestination = path.join(root, "old-destination");
    const newDestination = path.join(root, "new-destination");
    await ctx.settings.set({ backupDirectory: newDestination });
    const keepThere = await ctx.appBackups.run(false, actor, schedule);
    await ctx.settings.set({ backupDirectory: oldDestination });
    const oldArchive = await ctx.appBackups.run(false, actor, schedule);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const waiting = new Promise<void>((r) => { entered = r; });
    const rows = vi.spyOn(ctx.servers, "rows").mockImplementationOnce(async () => { entered(); await gate; return []; });
    const backup = ctx.appBackups.run(false, actor, schedule);
    await waiting;
    try {
      await ctx.settings.set({ backupDirectory: newDestination });
      release();
      const created = await backup;
      expect(await fs.readdir(path.join(oldDestination, "application"))).toEqual([created]);
      expect(created).not.toBe(oldArchive);
      expect(await fs.readdir(path.join(newDestination, "application"))).toEqual([keepThere]);
    } finally { release(); await backup.catch(() => {}); rows.mockRestore(); await ctx.settings.set({ backupDirectory: "" }); }
  });

  it("boots a persisted cron job once per scheduled minute and honours disabled schedules", async () => {
    const active = await ctx.schedules.create(input({ cron: "* * * * * *", enabled: true, payload: { includeServers: false, keep: 1 } }), actor);
    const paused = await ctx.schedules.create(input({ cron: "* * * * * *", enabled: false }), actor);
    await ctx.schedules.boot();
    await ctx.schedules.boot();
    try {
      await vi.waitFor(async () => expect((await ctx.schedules.runs(active.id)).filter((r) => r.status === "success")).toHaveLength(1), { timeout: 5000, interval: 100 });
      expect(await ctx.schedules.runs(paused.id)).toHaveLength(0);
      expect((await ctx.schedules.get(active.id)).nextRunAt).not.toBeNull();
      await ctx.schedules.update(active.id, input({ enabled: false }), actor);
      expect((await ctx.schedules.get(active.id)).nextRunAt).toBeNull();
    } finally { ctx.schedules.stop(); }
  }, 10_000);
});
