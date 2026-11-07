import { EventEmitter } from "node:events";
import type { ConsoleLine, OnlinePlayer, ServerMetrics, ServerSoftware, ServerStatus } from "@craftpanel/shared";
import { ManagedServer, type LaunchSpec } from "./managed-server";
import { createProcessProbe, isJavaProcess, isPidAlive, type ProcessProbe } from "./process-info";
import { parseMspt, parseTps, type LogSignal } from "./log-parser";

export interface AgentEvents {
  status: [serverId: string, status: ServerStatus, detail?: string];
  lines: [serverId: string, lines: ConsoleLine[]];
  players: [serverId: string, players: OnlinePlayer[]];
  metrics: [serverId: string, metrics: ServerMetrics];
  signal: [serverId: string, signal: LogSignal];
  exit: [serverId: string, info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
}

/**
 * Contract between the Control API and a runtime agent. Today the only
 * implementation is in-process (`LocalAgent`); a remote agent would expose
 * the same operations over an authenticated RPC channel.
 */
export interface RuntimeAgent extends EventEmitter<AgentEvents> {
  start(serverId: string, spec: LaunchSpec & { software: ServerSoftware }): void;
  stop(serverId: string, timeoutMs?: number): Promise<boolean>;
  kill(serverId: string): void;
  send(serverId: string, command: string): void;
  query(serverId: string, command: string, pattern: RegExp, opts?: { timeoutMs?: number; swallow?: RegExp }): Promise<RegExpExecArray | null>;
  status(serverId: string): ServerStatus;
  info(serverId: string): { pid: number | null; startedAt: number | null; readyAt: number | null; players: OnlinePlayer[]; lastError: string | null; lastExitCode: number | null; maxPlayers: number | null };
  history(serverId: string, limit?: number): ConsoleLine[];
  latestMetrics(serverId: string): ServerMetrics | null;
  watch(serverId: string): () => void;
  isRunning(serverId: string): boolean;
  /** Check whether a PID recorded by a previous run is still a live Java process. */
  probeOrphan(pid: number): Promise<boolean>;
  terminatePid(pid: number, force: boolean): boolean;
  forget(serverId: string): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

const RESOURCE_INTERVAL_MS = 5000;
const TICK_INTERVAL_MS = 15000;

export class LocalAgent extends EventEmitter<AgentEvents> implements RuntimeAgent {
  private servers = new Map<string, ManagedServer>();
  private software = new Map<string, ServerSoftware>();
  private watchers = new Map<string, number>();
  private timers = new Map<string, { res: NodeJS.Timeout; tick: NodeJS.Timeout }>();
  private metrics = new Map<string, ServerMetrics>();
  private tickSupport = new Map<string, boolean>();
  private probe: ProcessProbe = createProcessProbe();

  private get(id: string): ManagedServer {
    let s = this.servers.get(id);
    if (!s) {
      s = new ManagedServer(id);
      s.on("status", (st, d) => {
        this.emit("status", id, st, d);
        this.syncSampling(id);
      });
      s.on("lines", (l) => this.emit("lines", id, l));
      s.on("players", (p) => this.emit("players", id, p));
      s.on("signal", (sig) => this.emit("signal", id, sig));
      s.on("exit", (info) => this.emit("exit", id, info));
      this.servers.set(id, s);
    }
    return s;
  }

  start(id: string, spec: LaunchSpec & { software: ServerSoftware }) {
    this.software.set(id, spec.software);
    this.tickSupport.delete(id);
    this.get(id).start(spec);
  }
  stop(id: string, timeoutMs?: number) {
    return this.get(id).stop(timeoutMs);
  }
  kill(id: string) {
    this.get(id).kill();
  }
  send(id: string, command: string) {
    this.get(id).send(command);
  }
  query(id: string, command: string, pattern: RegExp, opts?: { timeoutMs?: number; swallow?: RegExp }) {
    return this.get(id).query(command, pattern, opts);
  }
  status(id: string): ServerStatus {
    return this.servers.get(id)?.status ?? "stopped";
  }
  isRunning(id: string) {
    return this.servers.get(id)?.isAlive ?? false;
  }
  info(id: string) {
    const s = this.get(id);
    return { pid: s.pid, startedAt: s.startedAt, readyAt: s.readyAt, players: s.players, lastError: s.lastError, lastExitCode: s.lastExitCode, maxPlayers: s.maxPlayers };
  }
  history(id: string, limit?: number) {
    return this.servers.get(id)?.history(limit) ?? [];
  }
  latestMetrics(id: string) {
    return this.metrics.get(id) ?? null;
  }
  systemLine(id: string, text: string, level: ConsoleLine["level"] = "INFO") {
    this.get(id).system(text, level);
  }
  setStatus(id: string, status: ServerStatus, detail?: string) {
    this.get(id).setStatus(status, detail);
  }

  /** Metrics are sampled only while someone is watching (no idle polling). */
  watch(id: string): () => void {
    this.watchers.set(id, (this.watchers.get(id) ?? 0) + 1);
    this.syncSampling(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers.set(id, Math.max(0, (this.watchers.get(id) ?? 1) - 1));
      this.syncSampling(id);
    };
  }

  private syncSampling(id: string) {
    const want = (this.watchers.get(id) ?? 0) > 0 && this.isRunning(id);
    const existing = this.timers.get(id);
    if (want && !existing) {
      const res = setInterval(() => void this.sampleResources(id), RESOURCE_INTERVAL_MS);
      const tick = setInterval(() => void this.sampleTicks(id), TICK_INTERVAL_MS);
      this.timers.set(id, { res, tick });
      void this.sampleResources(id);
    } else if (!want && existing) {
      clearInterval(existing.res);
      clearInterval(existing.tick);
      this.timers.delete(id);
    }
    if (!this.isRunning(id)) this.metrics.delete(id);
  }

  private async sampleResources(id: string) {
    const s = this.servers.get(id);
    if (!s?.pid) return;
    const r = await this.probe.sample(s.pid);
    const prev = this.metrics.get(id);
    const m: ServerMetrics = {
      ts: Date.now(),
      cpuPercent: r.cpuPercent,
      memoryBytes: r.memoryBytes,
      tps: prev?.tps ?? null,
      mspt: prev?.mspt ?? null,
      uptimeMs: s.startedAt ? Date.now() - s.startedAt : null,
      playersOnline: s.players.length,
    };
    this.metrics.set(id, m);
    this.emit("metrics", id, m);
  }

  private async sampleTicks(id: string) {
    const s = this.servers.get(id);
    if (!s || s.status !== "running") return;
    if (this.tickSupport.get(id) === false) return;
    let tps: number | null = null;
    let mspt: number | null = null;
    if (this.software.get(id) === "paper") {
      const m = await s.query("tps", /TPS from last 1m, 5m, 15m:.*/, { timeoutMs: 3000 });
      tps = m ? parseTps(m[0]) : null;
      const ms = await s.query("mspt", /^[◴\s]*([\d.]+)\/([\d.]+)\/([\d.]+)/, { timeoutMs: 3000, swallow: /Server tick times|^\s*$/ });
      mspt = ms ? Number(ms[1]) : null;
    } else {
      // `tick query` exists since 1.20.3; older versions answer "Unknown or incomplete command".
      const m = await s.query("tick query", /Average time per tick:.*|Unknown or incomplete command.*/, {
        timeoutMs: 3000,
        swallow: /^The game is running normally|^Target tick rate|^Percentiles:|^P50:|^P\d+|^<--\[HERE\]|^tick query/,
      });
      if (m && /Unknown/.test(m[0])) {
        this.tickSupport.set(id, false);
        return;
      }
      mspt = m ? parseMspt(m[0]) : null;
      if (mspt !== null) tps = Math.min(20, 1000 / Math.max(mspt, 50));
    }
    const prev = this.metrics.get(id);
    const next: ServerMetrics = {
      ts: Date.now(),
      cpuPercent: prev?.cpuPercent ?? null,
      memoryBytes: prev?.memoryBytes ?? null,
      uptimeMs: s.startedAt ? Date.now() - s.startedAt : null,
      playersOnline: s.players.length,
      tps,
      mspt,
    };
    this.metrics.set(id, next);
    this.emit("metrics", id, next);
  }

  async probeOrphan(pid: number) {
    return isJavaProcess(pid);
  }

  terminatePid(pid: number, force: boolean): boolean {
    if (!isPidAlive(pid)) return false;
    try {
      // SIGTERM triggers Minecraft's shutdown hook (world save) on Unix.
      // On Windows both map to TerminateProcess.
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  forget(id: string) {
    const s = this.servers.get(id);
    if (s?.isAlive) throw new Error("Cannot forget a running server");
    s?.removeAllListeners();
    this.servers.delete(id);
    this.metrics.delete(id);
  }

  /** Gracefully stop every running server (used on CraftPanel shutdown). */
  async shutdown(timeoutMs = 60_000) {
    await Promise.all([...this.servers.values()].filter((s) => s.isAlive).map((s) => s.stop(timeoutMs)));
    for (const t of this.timers.values()) {
      clearInterval(t.res);
      clearInterval(t.tick);
    }
    this.timers.clear();
    this.probe.dispose();
  }
}
