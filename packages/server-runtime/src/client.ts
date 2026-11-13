import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import { AppError, type ConsoleLine, type ServerSoftware, type ServerStatus } from "@craftpanel/shared";
import type { AgentEvents, RuntimeAgent } from "./agent";
import type { LaunchSpec, ResourceLimits } from "./managed-server";
import { isJavaProcess, isPidAlive } from "./process-info";
import { runtimeReporter, type RuntimeDiagnosticSink } from "./diagnostics";
import type { RuntimePathAccess } from "./access";
import type { IsolationStatus } from "./isolation";
import type { LimitSupport } from "./cgroups";
import { channel, COMMAND_TTL_MS, emptyRuntimeInfo, RUNTIME_PROTOCOL, prepareRuntimeEndpoint, type RuntimeSnapshot } from "./protocol";

/** A dashboard connection, never an owner of Minecraft processes. No command retries. */
export class RuntimeClient extends EventEmitter<AgentEvents> implements RuntimeAgent {
  connected = false;
  identity: { protocol: number; build: string; isolation?: IsolationStatus; limits?: LimitSupport } | null = null;
  private socket: Socket | null = null;
  private sendFrame: ((m: object) => boolean) | null = null;
  private epoch = "";
  private session = "";
  private sequence = 0;
  private snapshots = new Map<string, RuntimeSnapshot>();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private watches = new Map<string, number>();
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  private connecting: Promise<void> | null = null;
  private report: ReturnType<typeof runtimeReporter>;

  constructor(private dataDir: string, diagnostics?: RuntimeDiagnosticSink) { super(); this.report = runtimeReporter("client", diagnostics); }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open() {
    try {
      const paths = await prepareRuntimeEndpoint(this.dataDir);
      const token = (await fs.readFile(paths.token, "utf8")).trim();
      if (this.closed) throw this.unavailable();
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(paths.endpoint);
        this.socket = socket;
        const timeout = setTimeout(() => { this.report("handshake-timeout"); reject(this.unavailable()); socket.destroy(); }, 3000);
        this.sendFrame = channel(socket, (m) => {
          if (m.type === "snapshot") {
            const s = m.snapshot as RuntimeSnapshot;
            this.snapshots.set(s.id, { ...s, lines: s.lines ?? this.snapshots.get(s.id)?.lines ?? [] });
          } else if (m.type === "ready") {
            if (m.protocol !== RUNTIME_PROTOCOL || typeof m.epoch !== "string" || typeof m.session !== "string") { this.report("invalid-handshake"); socket.destroy(); return; }
            this.epoch = m.epoch;
            this.identity = { protocol: RUNTIME_PROTOCOL, build: typeof m.build === "string" ? m.build : "unknown", isolation: parseIsolation(m.isolation), limits: parseLimitSupport(m.limits) };
            this.session = m.session;
            this.sequence = 0;
            this.connected = true;
            clearTimeout(timeout);
            this.emit("connection", true);
            for (const id of this.watches.keys()) void this.call("watch", id).catch(() => undefined);
            this.heartbeat = setInterval(() => void this.call("ping").catch(() => socket.destroy()), 5000);
            this.heartbeat.unref();
            resolve();
          } else if (this.connected && m.type === "event") {
            const s = m.snapshot as RuntimeSnapshot;
            const old = this.snapshots.get(s.id);
            s.lines = old?.lines ?? [];
            if (m.event === "lines") s.lines = [...s.lines, ...((m.args as [string, ConsoleLine[]])[1])].slice(-2000);
            this.snapshots.set(s.id, s);
            const emit = this.emit.bind(this) as (event: string, ...args: unknown[]) => boolean;
            emit(String(m.event), ...(m.args as unknown[]));
          } else if (this.connected && m.type === "reply") {
            const p = this.pending.get(m.seq as number);
            if (!p) return;
            this.pending.delete(m.seq as number);
            clearTimeout(p.timer);
            if (typeof m.error === "string") p.reject(new AppError(409, "runtime_rejected", m.error));
            else p.resolve(m.result);
          }
        }, this.report);
        socket.once("connect", () => {
          this.snapshots.clear();
          this.sendFrame?.({ type: "hello", protocol: RUNTIME_PROTOCOL, token });
        });
        socket.on("error", (error) => this.report("socket-error", error));
        socket.once("close", () => {
          clearTimeout(timeout);
          if (!this.closed) this.report("connection-closed");
          if (this.socket === socket) this.lost();
          reject(this.unavailable());
        });
      });
    } catch (err) {
      if (!this.closed) this.report("connection-failed", err);
      this.scheduleReconnect();
      throw err;
    }
  }

  private unavailable() {
    return new AppError(503, "runtime_disconnected", "The Minecraft runtime connection is unavailable", "Server state is unknown. Commands are not queued. If a connection broke during a command, check the actual state before trying again.");
  }
  private assertConnected() { if (!this.connected) throw this.unavailable(); }
  private scheduleReconnect() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; void this.connect().catch(() => undefined); }, 1000);
    this.retry.unref();
  }
  private lost() {
    const wasConnected = this.connected;
    this.connected = false;
    this.sendFrame = null;
    this.socket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.unavailable()); }
    this.pending.clear();
    if (wasConnected) this.emit("connection", false);
    this.scheduleReconnect();
  }
  private call(method: string, id = "", extra: object = {}, waitMs = 10_000): Promise<unknown> {
    this.assertConnected();
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Disconnect cancels all outstanding requests. Never allow an uncertain late reply to continue a workflow.
        this.report("command-reply-timeout");
        this.socket?.destroy();
        this.lost();
      }, waitMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.sendFrame?.({ type: "call", epoch: this.epoch, session: this.session, seq, deadline: Date.now() + COMMAND_TTL_MS, method, id, ...extra });
    });
  }

  // Isolated hosts prepare the server directory first; large modpacks take a while.
  async start(id: string, spec: LaunchSpec & { software: ServerSoftware; autoStart?: boolean }) { await this.call("start", id, { spec }, 120_000); }
  async checkPaths(directory: string, javaPath: string) { return await this.call("checkPaths", "", { directory, javaPath }, 15_000) as RuntimePathAccess; }
  async configure(id: string, spec: LaunchSpec & { software: ServerSoftware; autoStart?: boolean }) { await this.call("configure", id, { spec }); }
  async stop(id: string, timeoutMs = 90_000) { return await this.call("stop", id, { timeoutMs }, timeoutMs + 5000) as boolean; }
  async kill(id: string) { await this.call("kill", id); }
  async share(id: string, path?: string) { await this.call("share", id, { path }, 120_000); }
  async setLimits(id: string, limits: ResourceLimits) { await this.call("limits", id, { limits }); }
  async send(id: string, command: string) { await this.call("send", id, { command }); }
  async query(id: string, command: string, pattern: RegExp, opts: { timeoutMs?: number; swallow?: RegExp } = {}) {
    const result = await this.call("query", id, { command, pattern: { source: pattern.source, flags: pattern.flags }, timeoutMs: opts.timeoutMs,
      swallow: opts.swallow ? { source: opts.swallow.source, flags: opts.swallow.flags } : undefined }, (opts.timeoutMs ?? 3000) + 5000) as { values: string[]; index: number; input: string; groups?: Record<string, string> } | null;
    return result ? Object.assign(result.values, { index: result.index, input: result.input, groups: result.groups }) as RegExpExecArray : null;
  }
  status(id: string): ServerStatus { return this.connected ? this.snapshots.get(id)?.status ?? "stopped" : "unknown"; }
  owns(id: string) { this.assertConnected(); return this.snapshots.get(id)?.registered ?? false; }
  info(id: string) { return this.connected ? this.snapshots.get(id)?.info ?? emptyRuntimeInfo() : emptyRuntimeInfo(); }
  history(id: string, limit = 2000) { return (this.snapshots.get(id)?.lines ?? []).slice(-limit); }
  latestMetrics(id: string) { return this.connected ? this.snapshots.get(id)?.metrics ?? null : null; }
  isRunning(id: string) { this.assertConnected(); return this.snapshots.get(id)?.alive ?? false; }
  watch(id: string) {
    this.watches.set(id, (this.watches.get(id) ?? 0) + 1);
    if (this.connected) void this.call("watch", id).catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.watches.get(id) ?? 1) - 1;
      if (count > 0) this.watches.set(id, count);
      else { this.watches.delete(id); if (this.connected) void this.call("unwatch", id).catch(() => undefined); }
    };
  }
  async probeOrphan(pid: number) { this.assertConnected(); return isJavaProcess(pid); }
  async terminatePid(pid: number, force: boolean) {
    this.assertConnected();
    if (!isPidAlive(pid)) return false;
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); return true; } catch { return false; }
  }
  async forget(id: string) { await this.call("forget", id); this.snapshots.delete(id); }
  async configureAutoStart(id: string, value: boolean) { await this.call("autoStart", id, { value }); }
  async stopAll(timeoutMs = 90_000) { return await this.call("stopAll", "", { timeoutMs }, timeoutMs + 5000) as { id: string; stopped: boolean }[]; }
  async requestServiceShutdown() { await this.call("shutdownRuntime"); }
  /** Kept for embedded callers. Stopping all servers is always explicit. */
  async shutdown(timeoutMs?: number) { await this.stopAll(timeoutMs); }
  async disconnect() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
    this.lost();
  }
}

function parseIsolation(v: unknown): IsolationStatus | undefined {
  const i = v as IsolationStatus | null;
  if (!i || (i.mode !== "isolated" && i.mode !== "shared")) return undefined;
  return { mode: i.mode, ...(typeof i.reason === "string" ? { reason: i.reason.slice(0, 300) } : {}), ...(Number.isInteger(i.accounts) ? { accounts: i.accounts } : {}) };
}

function parseLimitSupport(v: unknown): LimitSupport | undefined {
  const l = v as LimitSupport | null;
  if (!l || typeof l.available !== "boolean") return undefined;
  return { available: l.available, ...(typeof l.reason === "string" ? { reason: l.reason.slice(0, 300) } : {}),
    ...(Array.isArray(l.controllers) ? { controllers: l.controllers.filter((c): c is string => typeof c === "string").slice(0, 8) } : {}) };
}
