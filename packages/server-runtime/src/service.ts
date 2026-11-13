import crypto from "node:crypto";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import { SOFTWARE_INFO, type ServerSoftware } from "@craftpanel/shared";
import { LocalAgent, type AgentEvents } from "./agent";
import type { LaunchHooks, LaunchSpec, ResourceLimits } from "./managed-server";
import { runtimeReporter, type RuntimeDiagnosticSink } from "./diagnostics";
import { asGameAccount, detectIsolation, isolationStatus, killLeftovers, prepareServerDirectory, probeAsGame, protectDataDirectory, shareJavaRuntime, shareServerPath, type GameSlot, type Isolation } from "./isolation";
import { Cgroups } from "./cgroups";
import { channel, COMMAND_TTL_MS, RUNTIME_PROTOCOL, runtimePaths, prepareRuntimeEndpoint, type RuntimeSnapshot } from "./protocol";

const EVENTS = ["status", "lines", "players", "metrics", "signal", "exit"] as const;
type Spec = LaunchSpec & { software: ServerSoftware; autoStart?: boolean };
/** `slot` is the game account index on isolated hosts; it stays with the server until it is forgotten. */
interface RecordEntry { spec: Spec; pid: number | null; slot?: number }

/** Owns processes without opening a TCP listener or accessing the dashboard DB. */
export class RuntimeService {
  readonly agent = new LocalAgent();
  readonly epoch = crypto.randomUUID();
  private paths: ReturnType<typeof runtimePaths>;
  private server = net.createServer((socket) => this.accept(socket));
  private peers = new Set<Socket>();
  private records: Record<string, RecordEntry> = Object.create(null);
  private token = "";
  private closing = false;
  private initialized = false;
  private writes: Promise<void> = Promise.resolve();
  private broadcasts = new Set<(event: keyof AgentEvents, args: unknown[]) => void>();
  private report: ReturnType<typeof runtimeReporter>;
  private closePromise: Promise<void> | null = null;
  private isolation: Isolation = { mode: "shared", reason: "Not detected yet" };
  private starting = new Set<string>();
  private cgroups = Cgroups.unavailable("Not detected yet");

  constructor(private dataDir: string, private build = "development", diagnostics?: RuntimeDiagnosticSink, private detect: () => Promise<Isolation> = detectIsolation,
    private detectLimits: () => Promise<Cgroups> = () => Cgroups.detect()) {
    this.paths = runtimePaths(dataDir);
    this.report = runtimeReporter("service", diagnostics);
    // Subscribe before serving; state is sent along with every event, before its consumers run.
    for (const event of EVENTS) this.agent.on(event, (...args: unknown[]) => {
      for (const broadcast of this.broadcasts) broadcast(event, args);
      if (this.initialized && !this.closing && (event === "status" || event === "exit")) void this.persist().catch((error) => {
        this.report("registry-write-failed", error);
        void this.close().catch((shutdownError) => this.report("shutdown-failed", shutdownError));
      });
      // Anything a plugin forked off must not outlive its server.
      if (event === "exit" && this.isolation.mode === "isolated") {
        const slot = this.slotOf(String(args[0]));
        if (slot) void killLeftovers(slot.uid).catch((error) => this.report("leftover-kill-failed", error));
      }
    });
  }

  private slotOf(id: string): GameSlot | null {
    const index = this.records[id]?.slot;
    return this.isolation.mode === "isolated" && index !== undefined ? this.isolation.slots.find((s) => s.index === index) ?? null : null;
  }

  /** Keeps a server on its game account; a new server takes the lowest free one. */
  private assignSlot(id: string): GameSlot {
    if (this.isolation.mode !== "isolated") throw new Error("Isolation is not active");
    const current = this.slotOf(id);
    if (current) return current;
    const used = new Set(Object.entries(this.records).filter(([other]) => other !== id).map(([, e]) => e.slot));
    const free = this.isolation.slots.find((s) => !used.has(s.index));
    if (!free) throw new Error(`All ${this.isolation.slots.length} game accounts are in use; re-run the installer with more accounts (CRAFTPANEL_GAME_ACCOUNTS)`);
    this.records[id].slot = free.index;
    return free;
  }

  /** Spawns a server, on isolated hosts under its own account with a prepared directory. */
  private limitHooks(id: string, spec: Spec): LaunchHooks | undefined {
    const limits = spec.limits;
    if (!limits || !(limits.memoryMb || limits.cpuPercent || limits.tasks)) return undefined;
    if (!this.cgroups.support.available) {
      this.agent.systemLine(id, `Resource limits are not applied: ${this.cgroups.support.reason}`, "WARN");
      return undefined;
    }
    return this.cgroups.hooks(id, () => this.records[id]?.spec.limits ?? limits, (error) => {
      this.report("limits-failed", error);
      this.agent.systemLine(id, `Resource limits could not be applied: ${error.message}`, "WARN");
    });
  }

  private async launch(id: string, spec: Spec) {
    const isolation = this.isolation;
    if (isolation.mode !== "isolated") return this.agent.start(id, spec, undefined, this.limitHooks(id, spec));
    const slot = this.assignSlot(id);
    await this.persist();
    await killLeftovers(slot.uid);
    // The dashboard may have created servers/ or runtimes/ since boot, or an installer reset the root.
    await protectDataDirectory(this.dataDir);
    await prepareServerDirectory(spec.directory, slot, this.dataDir);
    if (!spec.command) await shareJavaRuntime(spec.javaPath, this.dataDir);
    const problem = await probeAsGame(isolation.setpriv, slot, spec.directory, spec.command?.file ?? spec.javaPath);
    if (problem) throw new Error(problem);
    // Preparation awaited; re-check right before spawning.
    if (this.closing) throw new Error("The runtime is shutting down");
    if (this.agent.isRunning(id)) throw new Error("The server is already running");
    await this.agent.start(id, spec, (file, args) => ({ ...asGameAccount(isolation.setpriv, slot, file, args), label: `as ${slot.name}` }), this.limitHooks(id, spec));
  }

  snapshot(id: string, history = false): RuntimeSnapshot {
    const info = this.agent.info(id);
    if (this.agent.status(id) === "orphaned") info.pid = this.records[id]?.pid ?? null;
    return { id, registered: Object.hasOwn(this.records, id), status: this.agent.status(id), info, alive: this.agent.isRunning(id), ...(history ? { lines: this.agent.history(id) } : {}), metrics: this.agent.latestMetrics(id) };
  }

  private persist() {
    for (const [id, entry] of Object.entries(this.records)) if (this.agent.status(id) !== "orphaned") entry.pid = this.agent.info(id).pid;
    const text = JSON.stringify({ protocol: RUNTIME_PROTOCOL, servers: this.records });
    this.writes = this.writes.then(async () => {
      await fs.writeFile(this.paths.registry + ".tmp", text, { mode: 0o600 });
      await fs.rename(this.paths.registry + ".tmp", this.paths.registry);
    });
    return this.writes;
  }

  async listen() {
    await fs.mkdir(this.paths.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.paths.directory, 0o700);
    this.paths = await prepareRuntimeEndpoint(this.dataDir);
    try {
      this.token = (await fs.readFile(this.paths.token, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error("Invalid runtime token; restore runtime/token before starting");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.token = crypto.randomBytes(32).toString("hex");
      await fs.writeFile(this.paths.token, this.token + "\n", { mode: 0o600, flag: "wx" });
    }
    // Never unlink a listening socket. A crashed Unix service may have left a dead socket inode.
    if (process.platform !== "win32") {
      const alive = await new Promise<boolean>((resolve, reject) => {
        const probe = net.connect(this.paths.endpoint);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (err: NodeJS.ErrnoException) => ["ENOENT", "ECONNREFUSED"].includes(err.code ?? "") ? resolve(false) : reject(err));
      });
      if (alive) throw new Error("The runtime is already listening for this data directory");
      await fs.rm(this.paths.endpoint, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      // Windows dashboard and runtime use different accounts. Pipe access is authenticated
      // by the private token; do not rely on the creator account's default pipe DACL.
      this.server.listen({ path: this.paths.endpoint, readableAll: process.platform === "win32", writableAll: process.platform === "win32" }, () => { this.server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") await fs.chmod(this.paths.endpoint, 0o600);
    this.isolation = await this.detect();
    this.cgroups = await this.detectLimits();
    if (this.isolation.mode === "isolated") {
      // Game accounts share files with the dashboard through their group, never through "other".
      process.umask(0o007);
      await protectDataDirectory(this.dataDir);
    }
    try {
      const saved = JSON.parse(await fs.readFile(this.paths.registry, "utf8")) as { protocol: number; servers: Record<string, RecordEntry> };
      if (saved.protocol !== RUNTIME_PROTOCOL || !saved.servers) throw new Error("Incompatible runtime registry; refusing to start servers");
      this.records = Object.assign(Object.create(null), saved.servers);
      for (const [id, entry] of Object.entries(this.records)) {
        validateSpec(entry.spec);
        // A runtime crash cannot reattach stdin. Never duplicate a possibly live process.
        if (entry.pid && await this.agent.probeOrphan(entry.pid)) {
          this.agent.setStatus(id, "orphaned", `Runtime lost ownership of PID ${entry.pid}; stop the process before starting again`);
          continue;
        }
        if (entry.spec.autoStart) await this.launch(id, entry.spec).catch((error) => {
          this.agent.setStatus(id, "error", (error as Error).message);
          this.report("autostart-failed", error);
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") { await this.close(); throw err; }
    }
    this.initialized = true;
    await this.persist();
  }

  private accept(socket: Socket) {
    this.peers.add(socket);
    socket.on("error", (error) => this.report("peer-socket-error", error));
    let authenticated = false;
    let session = "";
    let sequence = 0;
    const watches = new Map<string, () => void>();
    const pausedSaves = new Set<string>();
    const deadline = setTimeout(() => { this.report("peer-handshake-timeout"); socket.destroy(); }, 3000);
    const broadcast = (event: keyof AgentEvents, args: unknown[]) => {
      send({ type: "event", event, args, snapshot: this.snapshot(String(args[0])) });
    };
    const send = channel(socket, (m) => {
      if (!authenticated) {
        if (!this.initialized || m.type !== "hello" || m.protocol !== RUNTIME_PROTOCOL || typeof m.token !== "string" || Buffer.byteLength(m.token) !== Buffer.byteLength(this.token) ||
            !crypto.timingSafeEqual(Buffer.from(m.token), Buffer.from(this.token))) { this.report("peer-handshake-rejected"); socket.destroy(); return; }
        authenticated = true;
        clearTimeout(deadline);
        session = crypto.randomUUID();
        for (const id of Object.keys(this.records)) send({ type: "snapshot", snapshot: this.snapshot(id, true) });
        this.broadcasts.add(broadcast);
        send({ type: "ready", protocol: RUNTIME_PROTOCOL, epoch: this.epoch, session, build: this.build, isolation: isolationStatus(this.isolation), limits: this.cgroups.support });
        return;
      }
      // No replay window: a command belongs to exactly this connection and runtime generation.
      if (this.closing || m.type !== "call" || m.epoch !== this.epoch || m.session !== session || !Number.isSafeInteger(m.seq) || (m.seq as number) !== sequence + 1) { this.report("peer-command-envelope-rejected"); socket.destroy(); return; }
      sequence = m.seq as number;
      const seq = sequence;
      if (typeof m.deadline !== "number" || m.deadline < Date.now() || m.deadline > Date.now() + COMMAND_TTL_MS + 1000) {
        send({ type: "reply", seq, error: "Command expired; it was not executed" }); return;
      }
      const id = typeof m.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(m.id) ? m.id : "";
      void (async () => {
        try {
          let result: unknown = null;
          if (!id && !["ping", "stopAll", "shutdownRuntime", "checkPaths"].includes(String(m.method))) throw new Error("Invalid server id");
          const entry = this.records[id];
          switch (m.method) {
            case "ping": break;
            case "checkPaths":
              if (typeof m.directory !== "string" || typeof m.javaPath !== "string" || m.directory.length > 4096 || m.javaPath.length > 4096) throw new Error("Invalid runtime paths");
              result = await this.agent.checkPaths(m.directory, m.javaPath);
              break;
            case "configure": {
              const spec = validateSpec(m.spec);
              this.records[id] = { spec, pid: entry?.pid ?? null, slot: entry?.slot };
              await this.persist();
              break;
            }
            case "shutdownRuntime":
              setTimeout(() => void this.close().catch((err) => { console.error(err); process.exitCode = 1; }), 50);
              break;
            case "start": {
              const spec = validateSpec(m.spec);
              if (entry?.pid && !this.agent.isRunning(id) && await this.agent.probeOrphan(entry.pid)) throw new Error("A previous runtime process is still running");
              // No awaits between the authoritative alive check and spawn.
              if (this.closing || socket.destroyed || (m.deadline as number) < Date.now()) throw new Error("Connection or command expired");
              if (this.agent.isRunning(id)) throw new Error("The server is already running");
              if (this.starting.has(id)) throw new Error("The server is already starting");
              this.records[id] = { spec, pid: null, slot: entry?.slot };
              this.starting.add(id);
              try { await this.launch(id, spec); } finally { this.starting.delete(id); }
              await this.persist();
              break;
            }
            case "share": {
              if (m.path !== undefined && (typeof m.path !== "string" || m.path.length > 4096)) throw new Error("Invalid path");
              const slot = this.slotOf(id);
              // Without an account the dashboard owns every file already.
              if (entry && slot) await shareServerPath(entry.spec.directory, (m.path as string | undefined) ?? "", slot, this.dataDir);
              break;
            }
            case "limits": {
              const limits = validateLimits(m.limits);
              if (!entry) throw new Error("Unknown server");
              entry.spec.limits = limits;
              await this.persist();
              if (this.agent.isRunning(id)) this.cgroups.update(id, limits);
              break;
            }
            case "stop": result = await this.agent.stop(id, timeout(m.timeoutMs)); break;
            case "kill": await this.agent.kill(id); break;
            case "send":
              await this.agent.send(id, command(m.command));
              if (m.command === "save-off") pausedSaves.add(id);
              if (m.command === "save-on") pausedSaves.delete(id);
              break;
            case "query": {
              const pattern = regex(m.pattern);
              if (m.command === "save-off") pausedSaves.add(id);
              if (m.command === "save-on") pausedSaves.delete(id);
              const match = await this.agent.query(id, command(m.command), pattern, { timeoutMs: timeout(m.timeoutMs, 3000), swallow: m.swallow ? regex(m.swallow) : undefined });
              result = match ? { values: [...match], index: match.index, input: match.input, groups: match.groups } : null;
              break;
            }
            case "watch": if (!watches.has(id)) watches.set(id, this.agent.watch(id)); break;
            case "unwatch": watches.get(id)?.(); watches.delete(id); break;
            case "forget": await this.agent.forget(id); delete this.records[id]; await this.persist(); break;
            case "autoStart":
              if (typeof m.value !== "boolean") throw new Error("Invalid auto-start value");
              if (entry) { entry.spec.autoStart = m.value; await this.persist(); }
              break;
            case "stopAll":
              result = await Promise.all(Object.keys(this.records).map(async (sid) => ({ id: sid, stopped: await this.agent.stop(sid, timeout(m.timeoutMs)) })));
              break;
            default: throw new Error("Unsupported runtime operation");
          }
          if (id) send({ type: "snapshot", snapshot: this.snapshot(id) });
          send({ type: "reply", seq, result });
        } catch (err) {
          send({ type: "reply", seq, error: (err as Error).message });
        }
      })();
    }, this.report);
    socket.once("close", () => {
      clearTimeout(deadline);
      this.broadcasts.delete(broadcast);
      for (const release of watches.values()) release();
      // A dashboard crash during a live backup must not leave Minecraft autosave disabled.
      for (const id of pausedSaves) if (this.agent.isRunning(id)) void this.agent.send(id, "save-on").catch(() => undefined);
      this.peers.delete(socket);
    });
  }

  close(timeoutMs = 90_000): Promise<void> {
    return this.closePromise ??= this.shutdown(timeoutMs);
  }

  private async shutdown(timeoutMs: number) {
    this.closing = true;
    for (const peer of this.peers) peer.destroy();
    const closed = this.server.listening ? new Promise<void>((resolve) => this.server.close(() => resolve())) : Promise.resolve();
    try {
      await this.agent.shutdown(timeoutMs);
      if (this.initialized) await this.persist();
    } finally {
      await closed;
      if (this.paths.socketAlias) {
        const alias = this.paths.socketAlias;
        const stat = await fs.lstat(alias).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
        if (stat?.isSymbolicLink() && stat.uid === process.getuid!() && await fs.readlink(alias) === this.paths.directory) await fs.unlink(alias);
      }
    }
  }
}

function command(v: unknown): string {
  if (typeof v !== "string" || !v.length || v.length > 8192 || /[\r\n\0]/.test(v)) throw new Error("Invalid console command");
  return v;
}
function timeout(v: unknown, fallback = 90_000): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 120_000) throw new Error("Invalid timeout");
  return v;
}
function regex(v: unknown): RegExp {
  const r = v as { source?: unknown; flags?: unknown } | null;
  if (!r || typeof r.source !== "string" || r.source.length > 8192 || typeof r.flags !== "string" || /[^imsu]/.test(r.flags)) throw new Error("Invalid query pattern");
  return new RegExp(r.source, r.flags);
}
function validateSpec(v: unknown): Spec {
  const s = v as Spec | null;
  if (!s || typeof s !== "object" || typeof s.javaPath !== "string" || typeof s.directory !== "string" || typeof s.jarFile !== "string" ||
      typeof s.software !== "string" || !Object.hasOwn(SOFTWARE_INFO, s.software) || !Number.isInteger(s.memoryMb) || s.memoryMb < 1 ||
      !Array.isArray(s.jvmArgs) || !s.jvmArgs.every((a) => typeof a === "string") ||
      (s.programArgs !== undefined && (!Array.isArray(s.programArgs) || !s.programArgs.every((a) => typeof a === "string"))) ||
      (s.command !== undefined && (typeof s.command.file !== "string" || !Array.isArray(s.command.args) || !s.command.args.every((a) => typeof a === "string"))) ||
      (s.autoStart !== undefined && typeof s.autoStart !== "boolean")) throw new Error("Invalid launch specification");
  if (s.limits !== undefined) s.limits = validateLimits(s.limits);
  return s;
}
function validateLimits(v: unknown): ResourceLimits {
  const l = v as ResourceLimits | null;
  const ok = (n: unknown, max: number) => n === undefined || (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max);
  if (!l || typeof l !== "object" || !ok(l.memoryMb, 4_194_304) || !ok(l.cpuPercent, 102_400) || !ok(l.tasks, 4_194_304)) throw new Error("Invalid resource limits");
  return { ...(l.memoryMb ? { memoryMb: l.memoryMb } : {}), ...(l.cpuPercent ? { cpuPercent: l.cpuPercent } : {}), ...(l.tasks ? { tasks: l.tasks } : {}) };
}
