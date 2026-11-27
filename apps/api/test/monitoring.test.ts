import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, metricBuckets, servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import type { MetricHistory, ServerMetrics } from "@craftpanel/shared";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { addSample, combine, HOUR, HOUR_RETENTION_MS, MINUTE, MINUTE_RETENTION_MS, toBucket, type Totals } from "../src/services/monitoring";

const sample = (ts: number, over: Partial<ServerMetrics> = {}): ServerMetrics => ({ ts, cpuPercent: 10, memoryBytes: 1000, tps: 20, mspt: 5, uptimeMs: 1, playersOnline: 1, ...over });
const blank = (): Totals => ({ cpuSum: 0, cpuN: 0, cpuMax: null, memorySum: 0, memoryN: 0, memoryMax: null, tpsSum: 0, tpsN: 0, tpsMin: null, msptSum: 0, msptN: 0, msptMax: null, playersSum: 0, playersN: 0, playersMax: null });

describe("metric buckets", () => {
  it("average only the samples that have a metric and keep the extremes", () => {
    const t = blank();
    addSample(t, sample(0, { cpuPercent: 10, tps: null, mspt: null }));
    addSample(t, sample(0, { cpuPercent: 30, tps: 18, mspt: 40 }));
    addSample(t, sample(0, { cpuPercent: null, tps: 20, mspt: 10, memoryBytes: Number.NaN }));
    expect(toBucket(5, t)).toEqual({ ts: 5, cpuAvg: 20, cpuMax: 30, memoryAvg: 1000, memoryMax: 1000, tpsAvg: 19, tpsMin: 18, msptAvg: 25, msptMax: 40, playersAvg: 1, playersMax: 1 });
    expect(toBucket(0, blank())).toMatchObject({ cpuAvg: null, cpuMax: null, tpsMin: null });
  });

  it("merge like the database does", () => {
    const a = blank();
    addSample(a, sample(0, { tps: null }));
    const b = blank();
    addSample(b, sample(0, { cpuPercent: 50, tps: 15 }));
    combine(a, b);
    expect(toBucket(0, a)).toMatchObject({ cpuAvg: 30, cpuMax: 50, tpsAvg: 15, tpsMin: 15 });
  });
});

describe("monitoring", () => {
  let root: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let id: string;
  let viewer: { cookie: string; csrf: string };
  let running = true;
  let now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const watched = new Set<string>();
  const released: string[] = [];
  const session = (r: { headers: Record<string, unknown>; json: () => { csrfToken: string } }) => ({ cookie: String(r.headers["set-cookie"]).split(";")[0]!, csrf: r.json().csrfToken });
  const history = async (range: string) => {
    const res = await app.inject({ method: "GET", url: `/api/servers/${id}/metrics?range=${range}`, headers: { cookie: viewer.cookie } });
    return { status: res.statusCode, body: res.json() as MetricHistory };
  };
  const emit = (m: ServerMetrics) => ctx.agent.emit("metrics", id, m);

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-monitoring-"));
    ctx = await createContext({ profile: "local", host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json", tls: null,
      layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
    id = crypto.randomUUID();
    vi.spyOn(ctx.agent, "serverIds").mockImplementation(() => [id]);
    vi.spyOn(ctx.agent, "isRunning").mockImplementation(() => running);
    vi.spyOn(ctx.agent, "watch").mockImplementation((sid) => {
      watched.add(sid);
      return () => { watched.delete(sid); released.push(sid); };
    });
    (ctx.monitoring as unknown as { now: () => number }).now = () => now;
    app = await buildApp(ctx, { logger: { level: "error" } });
    const owner = session(await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } }));
    await app.inject({ method: "POST", url: "/api/users", payload: { username: "viewer", password: "viewer-password-1", role: "viewer", serverScope: "all", serverRoles: {} }, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
    viewer = session(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password-1" } }));
    await ctx.database.db.insert(servers).values({ id, name: "Monitor", software: "paper", mcVersion: "1.21.4", javaMajor: 21, memoryMb: 1024,
      directory: path.join(root, "servers", "m"), port: 25599, bindAddress: "127.0.0.1", maxPlayers: 8, installState: "installed", eulaAccepted: true, jarFile: "server.jar", createdAt: now, updatedAt: now });
    ctx.monitoring.start();
  });
  afterAll(async () => {
    await ctx?.monitoring.stop();
    await app?.close();
    ctx?.database.close();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("watches running servers without a dashboard and lets go when they stop", () => {
    expect(watched.has(id)).toBe(true);
    running = false;
    ctx.agent.emit("status", id, "stopped");
    expect(watched.has(id)).toBe(false);
    expect(released).toEqual([id]);
    running = true;
    ctx.agent.emit("status", id, "running");
    expect(watched.has(id)).toBe(true);
  });

  it("survives a lost runtime connection and syncs again when it returns", () => {
    // RuntimeClient's reads throw while disconnected; an exception in an event listener would end the process.
    const connected = vi.spyOn(ctx.agent, "connected", "get").mockReturnValue(false);
    const ids = vi.spyOn(ctx.agent, "serverIds").mockImplementation(() => { throw new Error("runtime_disconnected"); });
    const alive = vi.spyOn(ctx.agent, "isRunning").mockImplementation(() => { throw new Error("runtime_disconnected"); });
    expect(() => ctx.agent.emit("connection", false)).not.toThrow();
    expect(() => ctx.agent.emit("status", id, "unknown")).not.toThrow();
    expect(watched.has(id)).toBe(true);
    connected.mockRestore();
    ids.mockImplementation(() => [id]);
    alive.mockImplementation(() => running);
    running = false;
    ctx.agent.emit("connection", true);
    expect(watched.has(id)).toBe(false);
    running = true;
    ctx.agent.emit("connection", true);
    expect(watched.has(id)).toBe(true);
  });

  it("checks the range and lets viewers read it", async () => {
    expect((await history("2y")).status).toBe(400);
    const recent = await history("1h");
    expect(recent.status).toBe(200);
    expect(recent.body).toEqual({ range: "1h", samples: [] });
  });

  it("stores minutes and hours, including the minute not written yet", async () => {
    const t0 = now;
    emit(sample(t0, { cpuPercent: 10, tps: 20, mspt: 4 }));
    emit(sample(t0 + 20_000, { cpuPercent: 30, tps: 16, mspt: 60, playersOnline: 3 }));
    emit(sample(t0 + MINUTE + 5_000, { cpuPercent: 50, tps: null, mspt: null }));
    now = t0 + MINUTE + 10_000;
    await ctx.monitoring.tick();
    const rows = await ctx.database.db.select().from(metricBuckets).where(eq(metricBuckets.serverId, id));
    expect(rows.map((r) => [r.resolution, r.ts, r.cpuN])).toEqual([[MINUTE, t0, 2], [HOUR, t0, 2]]);

    const day = await history("24h");
    expect(day.body).toMatchObject({ range: "24h", resolutionMs: MINUTE });
    if (day.body.range === "1h") throw new Error("unreachable");
    expect(day.body.buckets).toEqual([
      { ts: t0, cpuAvg: 20, cpuMax: 30, memoryAvg: 1000, memoryMax: 1000, tpsAvg: 18, tpsMin: 16, msptAvg: 32, msptMax: 60, playersAvg: 2, playersMax: 3 },
      expect.objectContaining({ ts: t0 + MINUTE, cpuAvg: 50, tpsAvg: null, tpsMin: null }),
    ]);
    const week = await history("7d");
    if (week.body.range === "1h") throw new Error("unreachable");
    expect(week.body.buckets).toEqual([expect.objectContaining({ ts: t0, cpuAvg: 30, cpuMax: 50, tpsMin: 16, playersMax: 3 })]);
  });

  it("merges a minute written in two parts instead of overwriting it", async () => {
    const minute = now - (now % MINUTE);
    await ctx.monitoring.flush(true);
    emit(sample(minute + 30_000, { cpuPercent: 80 }));
    await ctx.monitoring.flush(true);
    const [row] = await ctx.database.db.select().from(metricBuckets).where(eq(metricBuckets.ts, minute));
    expect(row).toMatchObject({ resolution: MINUTE, cpuN: 2, cpuSum: 130, cpuMax: 80 });
    const [hour] = await ctx.database.db.select().from(metricBuckets).where(eq(metricBuckets.resolution, HOUR));
    expect(hour).toMatchObject({ cpuN: 4, cpuMax: 80, tpsMin: 16 });
  });

  it("prunes minutes after a day and hours after a month", async () => {
    await ctx.monitoring.prune(now + MINUTE_RETENTION_MS + HOUR);
    expect((await ctx.database.db.select().from(metricBuckets)).map((r) => r.resolution)).toEqual([HOUR]);
    await ctx.monitoring.prune(now + HOUR_RETENTION_MS + 2 * HOUR);
    expect(await ctx.database.db.select().from(metricBuckets)).toEqual([]);
  });

  it("forgets a deleted server's history", async () => {
    emit(sample(now));
    await ctx.monitoring.flush(true);
    expect((await ctx.database.db.select().from(metricBuckets)).length).toBe(2);
    for (const hook of ctx.servers.hooks.deleted) await hook(id);
    expect(await ctx.database.db.select().from(metricBuckets)).toEqual([]);
  });
});
