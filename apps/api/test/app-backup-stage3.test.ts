import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import { listZip, readZipEntry } from "@craftpanel/backup";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { decryptApplicationBackup, encryptedBackupHeader } from "../src/app-backup-crypto";
import { importApplicationBackup } from "../src/app-restore";
import { scheduleSchema } from "@craftpanel/shared";
import { createRestoreWorkspace, recoverSetupRestores, writeRestoreJournal } from "../src/setup-restore-transaction";

const password = "archive-only-passphrase-1";
const schedulerPassword = "host-only-schedule-passphrase-1";
const config = (root: string, network = false) => ({ profile: "local" as const, host: network ? "0.0.0.0" : "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json" as const, tls: null,
  layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false as const, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: !network });

describe("encrypted application archives and first-run restore", () => {
  let root: string;
  let source: AppContext;
  let sourceApp: FastifyInstance;
  let encrypted: string;
  let serverId: string;
  let earlierBackupId: string;
  let scheduleId: string;
  const contexts: { ctx: AppContext; app: FastifyInstance }[] = [];
  const actor = { id: null, username: "owner" };

  async function fresh(name: string, network = false) {
    const ctx = await createContext(config(path.join(root, name), network));
    const app = await buildApp(ctx, { logger: false });
    vi.spyOn(ctx.servers, "recover").mockResolvedValue(); // Real reinstallation/autostart belongs to the Paper acceptance scenario.
    contexts.push({ ctx, app });
    return { ctx, app };
  }
  async function upload(app: FastifyInstance, archive: string, passphrase = password, setupToken?: string, remoteAddress = "127.0.0.1") {
    const boundary = `backup-${crypto.randomUUID()}`;
    const file = await fs.readFile(archive);
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n${passphrase}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.cpbackup"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return app.inject({ method: "POST", url: "/api/auth/restore", remoteAddress, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...(setupToken ? { "x-setup-token": setupToken } : {}) }, payload });
  }
  async function finished(app: FastifyInstance, token: string) {
    let state;
    await vi.waitFor(async () => { const r = await app.inject({ method: "GET", url: "/api/auth/restore/status", headers: { "x-restore-token": token } }); expect(r.statusCode).toBe(200); state = r.json(); expect(state.running).toBe(false); }, { timeout: 15_000, interval: 50 });
    return state as unknown as { error: string | null; result: { servers: number; backups: number } | null };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-stage3-"));
    source = await createContext(config(path.join(root, "source")));
    sourceApp = await buildApp(source, { logger: false });
    await sourceApp.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
    serverId = crypto.randomUUID();
    const directory = path.join(source.config.layout.servers, serverId);
    await fs.mkdir(path.join(directory, "world"), { recursive: true });
    await fs.writeFile(path.join(directory, "world", "level.dat"), "world-before-the-move");
    await fs.writeFile(path.join(directory, "server.properties"), "level-name=world\nserver-port=25599\n");
    await fs.writeFile(path.join(directory, "server.jar"), "download-me-again");
    await source.database.db.insert(servers).values({ id: serverId, name: "Restored server", software: "paper", mcVersion: "1.21.4", javaMajor: 21, memoryMb: 1024, directory, port: 25599, bindAddress: "127.0.0.1", installState: "installed", eulaAccepted: true, jarFile: "server.jar", autoStart: false, createdAt: Date.now(), updatedAt: Date.now() });
    earlierBackupId = (await source.backups.create(serverId, "manual", actor, "Earlier world")).id;
    const schedule = await source.schedules.create(scheduleSchema.parse({ name: "Encrypted nightly", cron: "0 4 * * *", action: "application-backup", enabled: true, payload: { encrypted: true, includeBackupHistory: true }, backupPassphrase: schedulerPassword }), actor);
    scheduleId = schedule.id;
    await source.settings.set({ dashboardAccess: "local" });
    const name = await source.appBackups.run(true, actor, undefined, { passphrase: password, includeBackupHistory: true });
    encrypted = await source.appBackups.file(name);
  }, 60_000);
  afterAll(async () => {
    for (const { ctx, app } of [...contexts, { ctx: source, app: sourceApp }]) {
      ctx.schedules.stop(); ctx.notifications.stop(); ctx.maps.stop(); await ctx.rules.stop(); await app.close(); ctx.database.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes only ciphertext, lists metadata, preserves server history, and excludes schedule passphrases", async () => {
    expect(encrypted.endsWith(".cpbackup")).toBe(true);
    expect((await fs.readFile(encrypted)).subarray(0, 8).toString()).toBe("CPBKENC1");
    expect((await source.appBackups.list())[0]).toMatchObject({ encrypted: true, history: 1, servers: { total: 1, withFiles: 1 } });
    const plain = path.join(root, "decrypted.zip");
    expect(await decryptApplicationBackup(encrypted, plain, password)).toBe(true);
    const entries = await listZip(plain);
    expect(entries.some((e) => e.name === `history/${earlierBackupId}.zip`)).toBe(true);
    expect(entries.some((e) => /passphrase/i.test(e.name))).toBe(false);
    const database = (await readZipEntry(plain, "database.sqlite"))!;
    expect(database.includes(Buffer.from(password))).toBe(false);
    expect(database.includes(Buffer.from(schedulerPassword))).toBe(false);
    expect(await fs.readdir(source.config.layout.tmp)).toEqual([]);
    expect((await fs.readdir(path.dirname(encrypted))).every((name) => name.endsWith(".cpbackup"))).toBe(true);
    const imported = dataLayout(path.join(root, "offline"));
    const result = await importApplicationBackup(imported, encrypted, { passphrase: password });
    expect(result).toMatchObject({ servers: 1, backups: 1 });
    expect(result.notes.join(" ")).toContain("paused");
    const restored = await createContext(config(imported.root));
    try {
      const earlier = await restored.backups.get(earlierBackupId);
      expect((await restored.backups.verify(earlier.id)).ok).toBe(true);
      expect((await restored.schedules.get(scheduleId)).enabled).toBe(false);
      expect(await restored.appBackups.passphrases.get(scheduleId)).toBeUndefined();
    } finally { restored.database.close(); }
  }, 30_000);

  it("rejects wrong passphrases, changed headers, changed ciphertext and truncated files before importing", async () => {
    const bytes = await fs.readFile(encrypted);
    const envelope = (await encryptedBackupHeader(encrypted))!;
    const variants = [Buffer.from(bytes), Buffer.from(bytes), bytes.subarray(0, bytes.length - 8)];
    variants[0]![envelope.offset + 1]! ^= 1;
    // Change authenticated, otherwise valid public metadata.
    const marker = Buffer.from('"history":1');
    const at = variants[1]!.indexOf(marker);
    expect(at).toBeGreaterThan(12);
    variants[1]![at + marker.length - 1] = "0".charCodeAt(0);
    for (const [index, variant] of variants.entries()) {
      const bad = path.join(root, `tampered-${index}.cpbackup`);
      await fs.writeFile(bad, variant);
      const target = dataLayout(path.join(root, `never-${index}`));
      await expect(importApplicationBackup(target, bad, { passphrase: password })).rejects.toThrow();
      await expect(fs.access(target.root)).rejects.toThrow();
    }
    await expect(importApplicationBackup(dataLayout(path.join(root, "wrong")), encrypted, { passphrase: "the-wrong-passphrase" })).rejects.toThrow(/Incorrect passphrase/);
    await expect(importApplicationBackup(dataLayout(path.join(root, "missing-key")), encrypted)).rejects.toThrow(/encrypted/);
  });

  it("protects first-run upload and status, leaves the fresh database intact after a bad passphrase, then restores and signs in", async () => {
    const { ctx, app } = await fresh("browser", true);
    expect((await upload(app, encrypted)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/auth/restore/status" })).statusCode).toBe(404);
    const wrong = await upload(app, encrypted, "wrong-but-long-passphrase", ctx.setupToken!);
    expect(wrong.statusCode).toBe(202);
    expect((await finished(app, wrong.json().token)).error).toMatch(/Incorrect passphrase/);
    expect((await app.inject({ method: "GET", url: "/api/auth/state" })).json().setupRequired).toBe(true);
    const started = await upload(app, encrypted, password, ctx.setupToken!);
    expect(started.statusCode).toBe(202);
    const state = await finished(app, started.json().token);
    expect(state.error).toBeNull();
    expect(state.result).toMatchObject({ servers: 1, backups: 1 });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "owner-password-1" } })).statusCode).toBe(200);
    expect((await ctx.settings.get()).dashboardAccess).toBe("private");
    expect((await ctx.servers.row(serverId)).directory).toBe(path.join(ctx.config.layout.servers, serverId));
    expect(await fs.readFile(path.join(ctx.config.layout.servers, serverId, "world/level.dat"), "utf8")).toBe("world-before-the-move");
    expect((await ctx.backups.verify(earlierBackupId)).ok).toBe(true);
    expect((await fs.readdir(ctx.config.layout.root)).some((n) => n.startsWith("setup-restore-"))).toBe(false);
    expect((await upload(app, encrypted, password, undefined, "127.0.0.2")).statusCode).toBe(409);
  }, 30_000);

  it("rolls back a failed database activation and keeps owner creation mutually exclusive", async () => {
    const { ctx, app } = await fresh("rollback");
    const release = ctx.setup.reserve();
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "other", password: "another-password-1" } })).statusCode).toBe(409);
    release();
    vi.spyOn(ctx.database, "reopen").mockImplementationOnce(() => { throw new Error("Activation probe"); });
    const started = await upload(app, encrypted);
    expect(started.statusCode).toBe(202);
    expect((await finished(app, started.json().token)).error).toMatch(/Activation probe/);
    expect(ctx.database.raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(await fs.readdir(ctx.config.layout.servers)).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "other", password: "another-password-1" } })).statusCode).toBe(200);
  });

  it("encrypts scheduled runs without exposing their passphrase in payloads or audit records", async () => {
    await source.schedules.runNow(scheduleId, actor);
    const listed = await source.appBackups.list();
    expect(listed.some((b) => b.scheduleId === scheduleId && b.encrypted)).toBe(true);
    expect(JSON.stringify(await source.schedules.get(scheduleId))).not.toContain(schedulerPassword);
    expect(JSON.stringify(await source.activity.listAudit())).not.toContain(schedulerPassword);
  });

  it("keeps status polling available while activation blocks other database requests", async () => {
    const { ctx, app } = await fresh("activation-gate");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(ctx.rules, "stop").mockImplementationOnce(() => paused);
    const started = await upload(app, encrypted);
    try {
      await vi.waitFor(() => expect(ctx.setup.activating).toBe(true));
      expect((await app.inject({ method: "GET", url: "/api/auth/state" })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: "/api/auth/restore/status", headers: { "x-restore-token": started.json().token } })).json().running).toBe(true);
      expect((await app.inject({ method: "GET", url: "/api/auth/restore/status" })).statusCode).toBe(404);
    } finally { resume(); }
    expect((await finished(app, started.json().token)).error).toBeNull();
  });

  it("keeps recovery files and blocks normal requests if the original database cannot reopen", async () => {
    const { ctx, app } = await fresh("failed-recovery");
    vi.spyOn(ctx.database, "reopen")
      .mockImplementationOnce(() => { throw new Error("Activation failed"); })
      .mockImplementationOnce(() => { throw new Error("Recovery could not reopen SQLite"); });
    const started = await upload(app, encrypted);
    expect((await finished(app, started.json().token)).error).toMatch(/Recovery could not reopen/);
    const status = await app.inject({ method: "GET", url: "/api/auth/restore/status", headers: { "x-restore-token": started.json().token } });
    expect(status.json().recoveryRequired).toBe(true);
    expect(ctx.setup.activating).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/auth/state" })).statusCode).toBe(503);
    const work = (await fs.readdir(ctx.config.layout.root)).find((name) => name.startsWith("setup-restore-"))!;
    expect(JSON.parse(await fs.readFile(path.join(ctx.config.layout.root, work, "transaction.json"), "utf8")).phase).toBe("activating");
    expect(await fs.readFile(path.join(ctx.config.layout.root, work, "staged", "craftpanel.db"))).not.toHaveLength(0);
  });
});

describe("first-run restore crash recovery", () => {
  it("discards the imported database's abandoned WAL before restoring the original", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-restore-wal-"));
    const layout = dataLayout(root);
    const work = await createRestoreWorkspace(layout);
    const from = path.join(work, "staged", "craftpanel.db");
    await fs.mkdir(path.dirname(from), { recursive: true });
    await fs.mkdir(path.join(work, "previous"));
    for (const [file, value] of [[layout.database, "original"], [from, "restored"]]) {
      const db = new DatabaseSync(file!);
      db.exec("CREATE TABLE probe (value TEXT)");
      db.prepare("INSERT INTO probe VALUES (?)").run(value!);
      db.close();
    }
    await writeRestoreJournal(work, [{ from, to: layout.database, replace: true }], "activating");
    const child = spawnSync(process.execPath, ["-e", `
      const fs = require('node:fs'), path = require('node:path'), { DatabaseSync } = require('node:sqlite');
      const [work, from, target] = process.argv.slice(1);
      fs.writeFileSync(path.join(work, 'owner.json'), JSON.stringify({pid:process.pid}));
      fs.renameSync(target, path.join(work, 'previous', '0'));
      fs.renameSync(from, target);
      const db = new DatabaseSync(target);
      db.exec("PRAGMA journal_mode=WAL; INSERT INTO probe VALUES ('written before activation commit')");
      process.kill(process.pid, 'SIGKILL');
    `, work, from, layout.database], { windowsHide: true, timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect((await fs.stat(layout.database + "-wal")).size).toBeGreaterThan(0);
    await recoverSetupRestores(layout);
    const recovered = new DatabaseSync(layout.database);
    try { expect(recovered.prepare("SELECT value FROM probe").all()).toEqual([{ value: "original" }]); }
    finally { recovered.close(); }
    expect(await fs.readdir(root)).toEqual(["craftpanel.db"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["old-moved", "new-moved", "committed"])("recovers a dead process at %s", async (phase) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-restore-crash-"));
    const layout = dataLayout(root);
    const work = await createRestoreWorkspace(layout);
    const from = path.join(work, "staged", "craftpanel.db");
    await fs.mkdir(path.dirname(from), { recursive: true });
    await fs.mkdir(path.join(work, "previous"));
    await fs.writeFile(from, "new database");
    await fs.writeFile(layout.database, "original database");
    await writeRestoreJournal(work, [{ from, to: layout.database, replace: true }], "activating");
    const child = spawnSync(process.execPath, ["-e", `
      const fs = require('node:fs'), path = require('node:path');
      const [work, from, target, phase] = process.argv.slice(1);
      fs.writeFileSync(path.join(work, 'owner.json'), JSON.stringify({pid:process.pid}));
      fs.renameSync(target, path.join(work, 'previous', '0'));
      if (phase !== 'old-moved') fs.renameSync(from, target);
      if (phase === 'committed') {
        const file = path.join(work, 'transaction.json');
        const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
        journal.phase = 'committed';
        fs.writeFileSync(file, JSON.stringify(journal));
      }
      process.kill(process.pid, 'SIGKILL');
    `, work, from, layout.database, phase], { windowsHide: true, timeout: 10_000 });
    expect(child.error).toBeUndefined();
    await recoverSetupRestores(layout);
    expect(await fs.readFile(layout.database, "utf8")).toBe(phase === "committed" ? "new database" : "original database");
    expect(await fs.readdir(root)).toEqual(["craftpanel.db"]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
