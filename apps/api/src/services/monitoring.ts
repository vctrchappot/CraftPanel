import os from "node:os";
import { and, eq, gte, hostMetricBuckets, lt, metricBuckets, sql, type Database } from "@craftpanel/database";
import { detectHost, freeDiskSpace } from "@craftpanel/server-runtime";
import {
  METRIC_RANGE_MS,
  METRIC_RESOLUTION_MS,
  type HostMetricBucket,
  type HostMetricHistory,
  type HostMetrics,
  type MetricBucket,
  type MetricHistory,
  type MetricRange,
  type ServerMetrics,
  type ServerStatus,
} from "@craftpanel/shared";
import type { ServerService } from "./servers";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
/** Minute buckets back the 24-hour view; hour buckets the 7- and 30-day views. */
export const MINUTE_RETENTION_MS = 26 * HOUR;
export const HOUR_RETENTION_MS = 31 * 24 * HOUR;
const FLUSH_MS = 30_000;
const HOST_SAMPLE_MS = 15_000;
/** Keep an hour of raw 15-second host samples in memory for the 15 min / 1 h views. */
const HOST_RAW_MAX = 260;

/** Sums, counts and extremes of the samples in one bucket, in the shape of a `metric_buckets` row. */
export interface Totals {
  cpuSum: number; cpuN: number; cpuMax: number | null;
  memorySum: number; memoryN: number; memoryMax: number | null;
  tpsSum: number; tpsN: number; tpsMin: number | null;
  msptSum: number; msptN: number; msptMax: number | null;
  playersSum: number; playersN: number; playersMax: number | null;
}
interface Pending extends Totals { serverId: string; ts: number }

/** Sums, counts and extremes of host samples in one bucket, in the shape of a `host_metric_buckets` row. */
export interface HostTotals {
  cpuSum: number; cpuN: number; cpuMax: number | null;
  memoryUsedSum: number; memoryUsedN: number; memoryUsedMax: number | null;
  memoryTotal: number | null;
  diskUsedSum: number; diskUsedN: number; diskUsedMax: number | null;
  diskTotal: number | null;
}
interface HostPending extends HostTotals { ts: number }

const empty = (): Totals => ({
  cpuSum: 0, cpuN: 0, cpuMax: null,
  memorySum: 0, memoryN: 0, memoryMax: null,
  tpsSum: 0, tpsN: 0, tpsMin: null,
  msptSum: 0, msptN: 0, msptMax: null,
  playersSum: 0, playersN: 0, playersMax: null,
});
const emptyHost = (): HostTotals => ({
  cpuSum: 0, cpuN: 0, cpuMax: null,
  memoryUsedSum: 0, memoryUsedN: 0, memoryUsedMax: null,
  memoryTotal: null,
  diskUsedSum: 0, diskUsedN: 0, diskUsedMax: null,
  diskTotal: null,
});
const hi = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
const lo = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const ok = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Adds one sample to a bucket; metrics the sample doesn't have leave their part untouched. */
export function addSample(t: Totals, m: ServerMetrics): void {
  if (ok(m.cpuPercent)) { t.cpuSum += m.cpuPercent; t.cpuN++; t.cpuMax = hi(t.cpuMax, m.cpuPercent); }
  if (ok(m.memoryBytes)) { t.memorySum += m.memoryBytes; t.memoryN++; t.memoryMax = hi(t.memoryMax, m.memoryBytes); }
  if (ok(m.tps)) { t.tpsSum += m.tps; t.tpsN++; t.tpsMin = lo(t.tpsMin, m.tps); }
  if (ok(m.mspt)) { t.msptSum += m.mspt; t.msptN++; t.msptMax = hi(t.msptMax, m.mspt); }
  if (ok(m.playersOnline)) { t.playersSum += m.playersOnline; t.playersN++; t.playersMax = hi(t.playersMax, m.playersOnline); }
}

/** Folds `b` into `a` (the same merge the database upsert does). */
export function combine(a: Totals, b: Totals): void {
  a.cpuSum += b.cpuSum; a.cpuN += b.cpuN; a.cpuMax = hi(a.cpuMax, b.cpuMax);
  a.memorySum += b.memorySum; a.memoryN += b.memoryN; a.memoryMax = hi(a.memoryMax, b.memoryMax);
  a.tpsSum += b.tpsSum; a.tpsN += b.tpsN; a.tpsMin = lo(a.tpsMin, b.tpsMin);
  a.msptSum += b.msptSum; a.msptN += b.msptN; a.msptMax = hi(a.msptMax, b.msptMax);
  a.playersSum += b.playersSum; a.playersN += b.playersN; a.playersMax = hi(a.playersMax, b.playersMax);
}

export function toBucket(ts: number, t: Totals): MetricBucket {
  const avg = (sum: number, n: number) => (n ? sum / n : null);
  return {
    ts,
    cpuAvg: avg(t.cpuSum, t.cpuN), cpuMax: t.cpuMax,
    memoryAvg: avg(t.memorySum, t.memoryN), memoryMax: t.memoryMax,
    tpsAvg: avg(t.tpsSum, t.tpsN), tpsMin: t.tpsMin,
    msptAvg: avg(t.msptSum, t.msptN), msptMax: t.msptMax,
    playersAvg: avg(t.playersSum, t.playersN), playersMax: t.playersMax,
  };
}

export function addHostSample(t: HostTotals, m: HostMetrics): void {
  if (ok(m.cpuPercent)) { t.cpuSum += m.cpuPercent; t.cpuN++; t.cpuMax = hi(t.cpuMax, m.cpuPercent); }
  if (ok(m.memoryUsedBytes)) { t.memoryUsedSum += m.memoryUsedBytes; t.memoryUsedN++; t.memoryUsedMax = hi(t.memoryUsedMax, m.memoryUsedBytes); }
  if (ok(m.memoryTotalBytes)) t.memoryTotal = hi(t.memoryTotal, m.memoryTotalBytes);
  if (ok(m.diskUsedBytes)) { t.diskUsedSum += m.diskUsedBytes; t.diskUsedN++; t.diskUsedMax = hi(t.diskUsedMax, m.diskUsedBytes); }
  if (ok(m.diskTotalBytes)) t.diskTotal = hi(t.diskTotal, m.diskTotalBytes);
}

export function combineHost(a: HostTotals, b: HostTotals): void {
  a.cpuSum += b.cpuSum; a.cpuN += b.cpuN; a.cpuMax = hi(a.cpuMax, b.cpuMax);
  a.memoryUsedSum += b.memoryUsedSum; a.memoryUsedN += b.memoryUsedN; a.memoryUsedMax = hi(a.memoryUsedMax, b.memoryUsedMax);
  a.memoryTotal = hi(a.memoryTotal, b.memoryTotal);
  a.diskUsedSum += b.diskUsedSum; a.diskUsedN += b.diskUsedN; a.diskUsedMax = hi(a.diskUsedMax, b.diskUsedMax);
  a.diskTotal = hi(a.diskTotal, b.diskTotal);
}

export function toHostBucket(ts: number, t: HostTotals): HostMetricBucket {
  const avg = (sum: number, n: number) => (n ? sum / n : null);
  return {
    ts,
    cpuAvg: avg(t.cpuSum, t.cpuN), cpuMax: t.cpuMax,
    memoryUsedAvg: avg(t.memoryUsedSum, t.memoryUsedN), memoryUsedMax: t.memoryUsedMax,
    memoryTotalBytes: t.memoryTotal,
    diskUsedAvg: avg(t.diskUsedSum, t.diskUsedN), diskUsedMax: t.diskUsedMax,
    diskTotalBytes: t.diskTotal,
  };
}

const totalsOf = (row: typeof metricBuckets.$inferSelect): Totals => {
  const { serverId: _s, resolution: _r, ts: _t, ...t } = row;
  return t;
};

const hostTotalsOf = (row: typeof hostMetricBuckets.$inferSelect): HostTotals => {
  const { resolution: _r, ts: _t, ...t } = row;
  return t;
};

// Upsert merge: sums and counts add up, extremes keep the larger (smaller) known value.
// In an upsert's DO UPDATE an unqualified column is the stored row; `excluded.` is the row that was to be inserted.
const add = (column: string) => sql.raw(`"${column}" + excluded."${column}"`);
const keep = (fn: "max" | "min", column: string) => sql.raw(`${fn}(coalesce("${column}", excluded."${column}"), coalesce(excluded."${column}", "${column}"))`);
const MERGE = {
  cpuSum: add("cpu_sum"), cpuN: add("cpu_n"), cpuMax: keep("max", "cpu_max"),
  memorySum: add("memory_sum"), memoryN: add("memory_n"), memoryMax: keep("max", "memory_max"),
  tpsSum: add("tps_sum"), tpsN: add("tps_n"), tpsMin: keep("min", "tps_min"),
  msptSum: add("mspt_sum"), msptN: add("mspt_n"), msptMax: keep("max", "mspt_max"),
  playersSum: add("players_sum"), playersN: add("players_n"), playersMax: keep("max", "players_max"),
};
const MERGE_HOST = {
  cpuSum: add("cpu_sum"), cpuN: add("cpu_n"), cpuMax: keep("max", "cpu_max"),
  memoryUsedSum: add("memory_used_sum"), memoryUsedN: add("memory_used_n"), memoryUsedMax: keep("max", "memory_used_max"),
  memoryTotal: keep("max", "memory_total"),
  diskUsedSum: add("disk_used_sum"), diskUsedN: add("disk_used_n"), diskUsedMax: keep("max", "disk_used_max"),
  diskTotal: keep("max", "disk_total"),
};

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Keeps a performance history of every running server and of the host machine itself, whether or not a dashboard
 * is open: holds a metrics watch on each running server, samples host CPU/memory/disk periodically, folds samples
 * into minute buckets and writes each finished minute into its minute and hour row. Buckets are pruned after
 * {@link MINUTE_RETENTION_MS} and {@link HOUR_RETENTION_MS}. The last hour at full detail stays in memory.
 */
export class MonitoringService {
  /** The minute being collected per server. */
  private current = new Map<string, Pending>();
  /** Finished server minutes not written yet. */
  private ready: Pending[] = [];
  /** Raw host samples from the last hour. */
  private hostSamples: HostMetrics[] = [];
  /** The host minute being collected. */
  private currentHost: HostPending | null = null;
  /** Finished host minutes not written yet. */
  private readyHost: HostPending[] = [];
  private prevCpu: { idle: number; total: number } | null = null;
  private watching = new Map<string, () => void>();
  private timer: NodeJS.Timeout | null = null;
  private hostTimer: NodeJS.Timeout | null = null;
  private lastPrune = 0;
  private writing: Promise<void> = Promise.resolve();
  private readonly onMetrics = (id: string, m: ServerMetrics) => this.record(id, m);
  private readonly onStatus = (id: string, _status: ServerStatus) => { try { this.sync(id); } catch { /* next event syncs */ } };
  private readonly onConnection = () => { try { this.syncAll(); } catch { /* next event syncs */ } };

  constructor(
    private db: Database,
    private servers: ServerService,
    private dataDir: string = process.cwd(),
    private now: () => number = Date.now,
  ) {
    servers.hooks.deleted.push(async (id) => {
      this.unwatch(id);
      this.current.delete(id);
      this.ready = this.ready.filter((p) => p.serverId !== id);
      await this.writing;
      await this.db.delete(metricBuckets).where(eq(metricBuckets.serverId, id));
    });
  }

  start() {
    if (this.timer) return;
    const agent = this.servers.agent;
    agent.on("metrics", this.onMetrics);
    agent.on("status", this.onStatus);
    agent.on("connection", this.onConnection);
    this.syncAll();
    this.prevCpu = cpuTotals();
    void this.sampleHost().catch(() => undefined);
    this.hostTimer = setInterval(() => void this.sampleHost().catch(() => undefined), HOST_SAMPLE_MS);
    this.hostTimer.unref();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), FLUSH_MS);
    this.timer.unref();
  }

  /** Stops watching and writes what was collected, including the minute in progress. */
  async stop() {
    const agent = this.servers.agent;
    agent.off("metrics", this.onMetrics);
    agent.off("status", this.onStatus);
    agent.off("connection", this.onConnection);
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.hostTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.watching.keys()]) this.unwatch(id);
    await this.flush(true);
  }

  // While the runtime is disconnected its state is unknown and its reads throw: the watches stay (the client
  // renews them on reconnect) and the next connection event syncs again. These run inside event listeners,
  // where an exception would end the dashboard process.
  private syncAll() {
    if (!this.servers.agent.connected) return;
    for (const id of new Set([...this.servers.agent.serverIds(), ...this.watching.keys()])) this.sync(id);
  }

  private sync(id: string) {
    if (!this.servers.agent.connected) return;
    const want = this.servers.agent.isRunning(id);
    if (want && !this.watching.has(id)) this.watching.set(id, this.servers.agent.watch(id));
    else if (!want) this.unwatch(id);
  }

  private unwatch(id: string) {
    this.watching.get(id)?.();
    this.watching.delete(id);
  }

  record(id: string, m: ServerMetrics) {
    const ts = Math.floor(m.ts / MINUTE) * MINUTE;
    let bucket = this.current.get(id);
    if (bucket && bucket.ts !== ts) {
      this.ready.push(bucket);
      bucket = undefined;
    }
    if (!bucket) {
      bucket = { serverId: id, ts, ...empty() };
      this.current.set(id, bucket);
    }
    addSample(bucket, m);
  }

  recordHost(m: HostMetrics) {
    this.hostSamples.push(m);
    if (this.hostSamples.length > HOST_RAW_MAX) this.hostSamples.splice(0, this.hostSamples.length - HOST_RAW_MAX);
    const ts = Math.floor(m.ts / MINUTE) * MINUTE;
    if (this.currentHost && this.currentHost.ts !== ts) {
      this.readyHost.push(this.currentHost);
      this.currentHost = null;
    }
    if (!this.currentHost) this.currentHost = { ts, ...emptyHost() };
    addHostSample(this.currentHost, m);
  }

  async sampleHost(): Promise<HostMetrics> {
    const cur = cpuTotals();
    let cpuPercent: number | null = null;
    if (this.prevCpu) {
      const totalDelta = cur.total - this.prevCpu.total;
      const idleDelta = cur.idle - this.prevCpu.idle;
      if (totalDelta > 0) cpuPercent = Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10));
    }
    this.prevCpu = cur;
    const host = detectHost();
    const memoryTotalBytes = host.memoryBytes;
    const memoryFreeBytes = Math.min(os.freemem(), memoryTotalBytes);
    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryFreeBytes);
    const disk = await freeDiskSpace(this.dataDir).catch(() => null);
    const m: HostMetrics = {
      ts: this.now(),
      cpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      diskUsedBytes: disk ? Math.max(0, disk.total - disk.free) : null,
      diskTotalBytes: disk?.total ?? null,
    };
    this.recordHost(m);
    return m;
  }

  async tick() {
    await this.flush(false);
    const now = this.now();
    if (now - this.lastPrune >= HOUR) {
      this.lastPrune = now;
      await this.prune(now);
    }
  }

  /** Writes finished minutes; `all` also writes the minute in progress (on shutdown). */
  flush(all: boolean): Promise<void> {
    const minute = Math.floor(this.now() / MINUTE) * MINUTE;
    for (const [id, bucket] of this.current) {
      if (all || bucket.ts < minute) {
        this.ready.push(bucket);
        this.current.delete(id);
      }
    }
    if (this.currentHost && (all || this.currentHost.ts < minute)) {
      this.readyHost.push(this.currentHost);
      this.currentHost = null;
    }
    const batch = this.ready;
    this.ready = [];
    const hostBatch = this.readyHost;
    this.readyHost = [];
    // Writes run one after another, so a shutdown flush waits for a timer flush that is still running.
    this.writing = this.writing.then(async () => {
      for (const p of batch) await this.write(p).catch(() => undefined);
      for (const h of hostBatch) await this.writeHost(h).catch(() => undefined);
    });
    return this.writing;
  }

  private async write(p: Pending) {
    const { serverId, ts, ...totals } = p;
    for (const resolution of [MINUTE, HOUR]) {
      await this.db
        .insert(metricBuckets)
        .values({ serverId, resolution, ts: Math.floor(ts / resolution) * resolution, ...totals })
        .onConflictDoUpdate({ target: [metricBuckets.serverId, metricBuckets.resolution, metricBuckets.ts], set: MERGE });
    }
  }

  private async writeHost(p: HostPending) {
    const { ts, ...totals } = p;
    for (const resolution of [MINUTE, HOUR]) {
      await this.db
        .insert(hostMetricBuckets)
        .values({ resolution, ts: Math.floor(ts / resolution) * resolution, ...totals })
        .onConflictDoUpdate({ target: [hostMetricBuckets.resolution, hostMetricBuckets.ts], set: MERGE_HOST });
    }
  }

  async prune(now = this.now()) {
    await this.db.delete(metricBuckets).where(and(eq(metricBuckets.resolution, MINUTE), lt(metricBuckets.ts, now - MINUTE_RETENTION_MS)));
    await this.db.delete(metricBuckets).where(and(eq(metricBuckets.resolution, HOUR), lt(metricBuckets.ts, now - HOUR_RETENTION_MS)));
    await this.db.delete(hostMetricBuckets).where(and(eq(hostMetricBuckets.resolution, MINUTE), lt(hostMetricBuckets.ts, now - MINUTE_RETENTION_MS)));
    await this.db.delete(hostMetricBuckets).where(and(eq(hostMetricBuckets.resolution, HOUR), lt(hostMetricBuckets.ts, now - HOUR_RETENTION_MS)));
  }

  /** History of a server for a range: raw samples for the last hour, buckets (including what isn't written yet) beyond. */
  async history(id: string, range: MetricRange): Promise<MetricHistory> {
    if (range === "1h") return { range, samples: this.servers.metricsHistory(id) };
    const resolutionMs = METRIC_RESOLUTION_MS[range];
    const from = Math.floor((this.now() - METRIC_RANGE_MS[range]) / resolutionMs) * resolutionMs;
    await this.writing;
    const rows = await this.db
      .select()
      .from(metricBuckets)
      .where(and(eq(metricBuckets.serverId, id), eq(metricBuckets.resolution, resolutionMs), gte(metricBuckets.ts, from)))
      .orderBy(metricBuckets.ts);
    const byTs = new Map<number, Totals>(rows.map((r) => [r.ts, totalsOf(r)]));
    const unwritten = [...this.ready.filter((p) => p.serverId === id), ...[this.current.get(id)].filter((p): p is Pending => !!p)];
    for (const p of unwritten) {
      const ts = Math.floor(p.ts / resolutionMs) * resolutionMs;
      if (ts < from) continue;
      const { serverId: _s, ts: _t, ...totals } = p;
      const into = byTs.get(ts);
      if (into) combine(into, totals);
      else byTs.set(ts, { ...totals });
    }
    const buckets = [...byTs].sort(([a], [b]) => a - b).map(([ts, t]) => toBucket(ts, t));
    return { range, resolutionMs, buckets };
  }

  /** History of the host machine for a range: raw samples for the last hour, buckets beyond. */
  async hostHistory(range: MetricRange): Promise<HostMetricHistory> {
    if (range === "1h") {
      const cutoff = this.now() - HOUR;
      return { range, samples: this.hostSamples.filter((s) => s.ts >= cutoff) };
    }
    const resolutionMs = METRIC_RESOLUTION_MS[range];
    const from = Math.floor((this.now() - METRIC_RANGE_MS[range]) / resolutionMs) * resolutionMs;
    await this.writing;
    const rows = await this.db
      .select()
      .from(hostMetricBuckets)
      .where(and(eq(hostMetricBuckets.resolution, resolutionMs), gte(hostMetricBuckets.ts, from)))
      .orderBy(hostMetricBuckets.ts);
    const byTs = new Map<number, HostTotals>(rows.map((r) => [r.ts, hostTotalsOf(r)]));
    const unwritten = [...this.readyHost, ...(this.currentHost ? [this.currentHost] : [])];
    for (const p of unwritten) {
      const ts = Math.floor(p.ts / resolutionMs) * resolutionMs;
      if (ts < from) continue;
      const { ts: _t, ...totals } = p;
      const into = byTs.get(ts);
      if (into) combineHost(into, totals);
      else byTs.set(ts, { ...totals });
    }
    const buckets = [...byTs].sort(([a], [b]) => a - b).map(([ts, t]) => toHostBucket(ts, t));
    return { range, resolutionMs, buckets };
  }
}
