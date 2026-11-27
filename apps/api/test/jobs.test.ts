import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, jobs, servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import type { JobInfo, WsServerMessage } from "@craftpanel/shared";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { JOB_RETENTION_MS } from "../src/services/jobs";
import { APP_BACKUP_PREFIX } from "../src/app-backup-format";

describe("jobs", () => {
  let root: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let a: string;
  let b: string;
  let owner: { cookie: string; csrf: string };
  let limited: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  const sent: { to: string; msg: WsServerMessage }[] = [];
  const system = { id: null, username: "system" };
  const session = (r: { headers: Record<string, unknown>; json: () => { csrfToken: string } }) => ({ cookie: String(r.headers["set-cookie"]).split(";")[0]!, csrf: r.json().csrfToken });
  const call = (auth: typeof owner, method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf } });
  const listed = async (auth: typeof owner, query = "") => ((await call(auth, "GET", `/api/jobs${query}`)).json() as JobInfo[]).map((j) => j.title);
  /** A job row as a dashboard that stopped would have left it. */
  const stale = async (over: Partial<typeof jobs.$inferInsert>) => {
    const id = crypto.randomUUID();
    await ctx.database.db.insert(jobs).values({ id, kind: "server.backup", serverId: a, title: "stale", actor: "owner", state: "running", stage: "Archiving", percent: 40, attempt: 1, startedAt: Date.now() - 1000, updatedAt: Date.now(), ...over });
    return id;
  };
  const row = async (id: string) => (await ctx.database.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-jobs-"));
    ctx = await createContext({ profile: "local", host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json", tls: null,
      layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
    vi.spyOn(ctx.hub, "broadcast").mockImplementation((msg) => void sent.push({ to: "visible", msg }));
    vi.spyOn(ctx.hub, "toOwners").mockImplementation((msg) => void sent.push({ to: "owners", msg }));
    app = await buildApp(ctx, { logger: { level: "error" } });
    owner = session(await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } }));
    a = crypto.randomUUID();
    b = crypto.randomUUID();
    for (const [id, name] of [[a, "Alpha"], [b, "Beta"]] as const) {
      await ctx.database.db.insert(servers).values({ id, name, software: "paper", mcVersion: "1.21.4", javaMajor: 21, memoryMb: 1024, directory: path.join(root, "servers", name),
        port: 25600 + name.length, bindAddress: "127.0.0.1", maxPlayers: 8, installState: "installed", eulaAccepted: true, jarFile: "server.jar", createdAt: Date.now(), updatedAt: Date.now() });
    }
    await call(owner, "POST", "/api/users", { username: "limited", password: "limited-password-1", role: "viewer", serverScope: "selected", serverRoles: { [a]: "viewer" } });
    await call(owner, "POST", "/api/users", { username: "admin", password: "admin-password-1", role: "admin", serverScope: "all", serverRoles: {} });
    limited = session(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "limited", password: "limited-password-1" } }));
    admin = session(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin-password-1" } }));
  });
  afterAll(async () => {
    await app?.close();
    ctx?.database.close();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("records a job's progress and result and passes its value through", async () => {
    sent.length = 0;
    const value = await ctx.jobs.run({ kind: "server.backup", serverId: a, title: "Back up Alpha", actor: system }, async (job) => {
      job.progress("Archiving", 12.6);
      job.progress("Archiving", 50);
      expect(await ctx.jobs.get(job.id)).toMatchObject({ state: "running", stage: "Archiving", percent: 50 });
      return 42;
    });
    expect(value).toBe(42);
    const [done] = (await ctx.jobs.list({ serverId: a, onlyServers: null, app: false })).filter((j) => j.title === "Back up Alpha");
    expect(done).toMatchObject({ state: "succeeded", percent: 100, attempt: 1, actor: "system", error: null });
    expect(done!.finishedAt).not.toBeNull();
    // Start, the first stage, the result; the quick second reading of the same stage waits for the throttle.
    const states = sent.filter((s) => s.msg.type === "job").map((s) => (s.msg as { job: JobInfo }).job);
    expect(states[0]!.state).toBe("running");
    expect(states.some((j) => j.stage === "Archiving")).toBe(true);
    expect(states.at(-1)!.state).toBe("succeeded");
    expect(sent.every((s) => s.to === "visible")).toBe(true);
  });

  it("records a failure with its message and rethrows it", async () => {
    await expect(ctx.jobs.run({ kind: "server.restore", serverId: b, title: "Restore Beta", actor: system }, async () => { throw new Error("archive damaged"); })).rejects.toThrow("archive damaged");
    const [failed] = await ctx.jobs.list({ serverId: b, onlyServers: null, app: false });
    expect(failed).toMatchObject({ title: "Restore Beta", state: "failed", error: "archive damaged" });
  });

  it("sends application jobs to owners only and lists them only for owners", async () => {
    sent.length = 0;
    await ctx.jobs.run({ kind: "app.backup", serverId: null, title: "Application backup", actor: system }, async () => undefined);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.to === "owners")).toBe(true);
    expect(await listed(owner)).toContain("Application backup");
    expect(await listed(admin)).not.toContain("Application backup");
    expect(await listed(admin)).toContain("Restore Beta");
    expect(await listed(limited)).toEqual(["Back up Alpha"]);
    // A server the user may not see is not found, like everywhere else.
    expect((await call(limited, "GET", `/api/jobs?serverId=${b}`)).statusCode).toBe(404);
    const appJob = (await ctx.jobs.list({ onlyServers: null, app: true })).find((j) => j.kind === "app.backup")!;
    expect((await call(admin, "GET", `/api/jobs/${appJob.id}`)).statusCode).toBe(404);
    expect((await call(owner, "GET", `/api/jobs/${appJob.id}`)).json()).toMatchObject({ title: "Application backup", state: "succeeded" });
  });

  it("resumes an interrupted installation once, then marks it interrupted", async () => {
    await ctx.database.db.update(servers).set({ installState: "failed" }).where(eq(servers.id, a));
    // Like the real installation, it awaits something (the server's row) before its job starts.
    const install = vi.spyOn(ctx.servers, "install").mockImplementation(async (id, actor, opts) => {
      await new Promise((r) => setTimeout(r, 20));
      await ctx.jobs.run({ kind: "server.install", serverId: id, title: "Install Paper 1.21.4", actor: actor ?? system, resume: opts?.resume }, async (job) => job.progress("Downloading", 30));
    });
    const first = await stale({ kind: "server.install", title: "Install Paper 1.21.4" });
    await ctx.jobs.recover();
    await vi.waitFor(async () => expect((await row(first)).state).toBe("succeeded"));
    expect(install).toHaveBeenCalledTimes(1);
    expect(await row(first)).toMatchObject({ attempt: 2, error: null });
    expect((await ctx.jobs.list({ serverId: a, onlyServers: null, app: false })).filter((j) => j.kind === "server.install")).toHaveLength(1);

    // A job that was already resumed once is not started a third time.
    const again = await stale({ kind: "server.install", title: "Install Paper 1.21.4", attempt: 2 });
    await ctx.jobs.recover();
    expect(install).toHaveBeenCalledTimes(1);
    expect(await row(again)).toMatchObject({ state: "interrupted", hint: "Retry the installation from the server's page." });

    // An installed server needs nothing.
    await ctx.database.db.update(servers).set({ installState: "installed" }).where(eq(servers.id, a));
    const done = await stale({ kind: "server.install", title: "Install Paper 1.21.4" });
    await ctx.jobs.recover();
    expect(install).toHaveBeenCalledTimes(1);
    expect((await row(done)).state).toBe("interrupted");
    install.mockRestore();
  });

  it("marks interrupted backups, restores and application backups with what to do and cleans up after them", async () => {
    const backup = await stale({});
    const restore = await stale({ kind: "server.restore", serverId: b });
    const appBackup = await stale({ kind: "app.backup", serverId: null });
    const dir = path.join(ctx.config.layout.backups, "application");
    await fsp.mkdir(dir, { recursive: true });
    const partial = path.join(dir, `${APP_BACKUP_PREFIX}2026-11-27T10-00-00-000.zip.partial`);
    const finished = path.join(dir, `${APP_BACKUP_PREFIX}2026-11-26T10-00-00-000.zip`);
    await fsp.writeFile(partial, "x");
    await fsp.writeFile(finished, "x");
    await fsp.mkdir(path.join(ctx.config.layout.tmp, "app-backup-0123456789ab", "content"), { recursive: true });
    await ctx.jobs.recover();
    await expect(fsp.access(partial)).rejects.toThrow();
    await fsp.access(finished);
    expect(await row(backup)).toMatchObject({ state: "interrupted", error: "CraftPanel stopped while this was running", hint: expect.stringContaining("Start the backup again") });
    expect((await row(restore)).hint).toContain("pre-restore");
    expect((await row(appBackup)).hint).toContain("Create the application backup again");
    await expect(fsp.access(path.join(ctx.config.layout.tmp, "app-backup-0123456789ab"))).rejects.toThrow();
  });

  it("keeps running jobs at the top, prunes old ones and forgets a deleted server's", async () => {
    await stale({ title: "still running elsewhere", startedAt: 1 });
    expect((await listed(owner))[0]).toBe("still running elsewhere");
    await ctx.database.db.update(jobs).set({ state: "failed" }).where(eq(jobs.title, "still running elsewhere"));
    await ctx.jobs.prune(Date.now() + JOB_RETENTION_MS + 60_000);
    expect(await listed(owner)).toEqual([]);
    await ctx.jobs.run({ kind: "server.backup", serverId: b, title: "Back up Beta", actor: system }, async () => undefined);
    for (const hook of ctx.servers.hooks.deleted) await hook(b).catch(() => undefined);
    expect(await listed(owner)).not.toContain("Back up Beta");
  });
});
