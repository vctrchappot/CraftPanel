import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  AppError,
  badRequest,
  conflict,
  createServerSchema,
  notFound,
  type InstallProgress,
  type ServerDetail,
  type ServerStatus,
  type ServerSummary,
} from "@craftpanel/shared";
import { eq, playerSessions, servers, and, isNull, type Database } from "@craftpanel/database";
import { getProvider, JavaManager, inspectJava, isJavaCompatible } from "@craftpanel/minecraft-providers";
import { PropertiesDocument } from "@craftpanel/config";
import { isPortAvailable } from "@craftpanel/network";
import { freeDiskSpace, LocalAgent, ServerSandbox } from "@craftpanel/server-runtime";
import type { z } from "zod";
import type { Hub } from "../hub";
import type { AppConfig } from "../config";
import { SYSTEM_ACTOR, type ActivityService, type Actor } from "./activity";
import { syncInfoPack } from "./info-pack";
import type { SettingsService } from "./settings";

export type ServerRow = typeof servers.$inferSelect;
const MARKER = ".craftpanel";

export class ServerService {
  /** Servers whose configuration changed while running. */
  readonly restartRequired = new Set<string>();
  private locks = new Map<string, string>();
  private installs = new Map<string, AbortController>();

  constructor(
    private db: Database,
    readonly agent: LocalAgent,
    private hub: Hub,
    private activity: ActivityService,
    readonly java: JavaManager,
    private config: AppConfig,
    private settings: SettingsService,
  ) {
    this.wireAgent();
  }

  // ---- locking ------------------------------------------------------------

  /** Serialize conflicting operations (start/restore/delete) per server. */
  async withLock<T>(id: string, op: string, fn: () => Promise<T>): Promise<T> {
    const held = this.locks.get(id);
    if (held) throw conflict(`Another operation is in progress (${held}). Try again when it finishes.`);
    this.locks.set(id, op);
    try {
      return await fn();
    } finally {
      this.locks.delete(id);
    }
  }
  busy(id: string) {
    return this.locks.get(id) ?? null;
  }

  // ---- queries ------------------------------------------------------------

  async row(id: string): Promise<ServerRow> {
    const [row] = await this.db.select().from(servers).where(eq(servers.id, id));
    if (!row) throw notFound("Server");
    return row;
  }

  async rows(): Promise<ServerRow[]> {
    return this.db.select().from(servers).orderBy(servers.createdAt);
  }

  status(row: ServerRow): ServerStatus {
    if (row.installState === "installing" || row.installState === "pending") return "installing";
    if (row.installState === "failed") return "error";
    const live = this.agent.status(row.id);
    if (live !== "stopped") return live;
    // Not owned by this process; trust persisted orphan/crash state from recovery.
    if (row.lastStatus === "orphaned" || row.lastStatus === "crashed" || row.lastStatus === "error") return row.lastStatus as ServerStatus;
    return "stopped";
  }

  summary(row: ServerRow): ServerSummary {
    const info = this.agent.info(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      software: row.software,
      mcVersion: row.mcVersion,
      build: row.build,
      port: row.port,
      networkMode: row.networkMode,
      status: this.status(row),
      installState: row.installState,
      installError: row.installError,
      eulaAccepted: row.eulaAccepted,
      autoStart: row.autoStart,
      memoryMb: row.memoryMb,
      playersOnline: info.players.length,
      maxPlayers: info.maxPlayers ?? row.maxPlayers,
      startedAt: info.startedAt,
      createdAt: row.createdAt,
      restartRequired: this.restartRequired.has(row.id),
    };
  }

  detail(row: ServerRow): ServerDetail {
    const info = this.agent.info(row.id);
    return {
      ...this.summary(row),
      directory: row.directory,
      javaMajor: row.javaMajor,
      javaPath: row.javaPath,
      jvmArgs: row.jvmArgs,
      bindAddress: row.bindAddress,
      pid: info.pid ?? (row.lastStatus === "orphaned" ? row.pid : null),
      exitCode: info.lastExitCode ?? row.lastExitCode,
      lastError: info.lastError ?? row.lastError,
      players: info.players,
    };
  }

  sandbox(row: ServerRow) {
    return new ServerSandbox(row.directory);
  }

  // ---- creation & installation -------------------------------------------

  async create(input: z.output<typeof createServerSchema>, actor: Actor): Promise<ServerRow> {
    const id = crypto.randomUUID();
    const provider = getProvider(input.software);
    const versions = await provider.listVersions();
    if (!versions.some((v) => v.id === input.mcVersion)) throw badRequest(`${provider.label} does not offer Minecraft ${input.mcVersion}`);
    const javaReq = await provider.javaRequirement(input.mcVersion);

    const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
    if (input.memoryMb > totalMb - 256) throw badRequest(`This machine has ${totalMb} MB of RAM. Allocate less memory to leave room for the operating system.`);

    const existing = await this.rows();
    if (existing.some((s) => s.port === input.port)) throw conflict(`Port ${input.port} is already assigned to another CraftPanel server`, "Choose a different port, e.g. " + (Math.max(...existing.map((s) => s.port)) + 1));
    if (!(await isPortAvailable(input.port))) throw conflict(`Port ${input.port} is in use by another program on this machine`);

    let directory: string;
    if (input.directory) {
      if (!path.isAbsolute(input.directory)) throw badRequest("Storage location must be an absolute path");
      directory = path.resolve(input.directory);
      try {
        const entries = await fsp.readdir(directory);
        if (entries.length) throw badRequest("The chosen storage location is not empty");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    } else {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "server";
      directory = path.join(this.config.layout.servers, `${slug}-${id.slice(0, 8)}`);
    }
    const disk = await freeDiskSpace(path.dirname(directory)).catch(() => null);
    if (disk && disk.free < 1024 ** 3) throw badRequest("Less than 1 GB of free disk space is available at the storage location");

    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, MARKER), JSON.stringify({ id, createdAt: new Date().toISOString() }));

    // Initial server.properties from the wizard; Minecraft fills in the rest on first start.
    const props = new PropertiesDocument();
    const set = (k: string, v: string | number | boolean) => props.set(k, String(v));
    set("motd", input.motd);
    set("server-port", input.port);
    set("server-ip", input.bindAddress);
    set("level-name", input.levelName);
    set("level-seed", input.seed);
    set("level-type", input.levelType);
    set("generate-structures", input.generateStructures);
    set("gamemode", input.gamemode);
    set("hardcore", input.hardcore);
    set("difficulty", input.hardcore ? "hard" : input.difficulty);
    set("max-players", input.maxPlayers);
    set("white-list", input.whitelist);
    set("enforce-whitelist", input.whitelist);
    set("online-mode", input.onlineMode);
    set("enable-rcon", false);
    set("query.port", input.port);
    await fsp.writeFile(path.join(directory, "server.properties"), "#Created by CraftPanel\n" + props.serialize());

    const now = Date.now();
    const [row] = await this.db
      .insert(servers)
      .values({
        id,
        name: input.name,
        description: input.description,
        software: input.software,
        mcVersion: input.mcVersion,
        build: input.build ?? null,
        javaMajor: javaReq.major,
        javaPath: input.javaPath ?? null,
        memoryMb: input.memoryMb,
        jvmArgs: input.jvmArgs,
        directory,
        port: input.port,
        networkMode: input.networkMode,
        bindAddress: input.bindAddress,
        eulaAccepted: input.acceptEula,
        eulaAcceptedAt: input.acceptEula ? now : null,
        autoStart: input.autoStart,
        installState: "pending",
        maxPlayers: input.maxPlayers,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (input.acceptEula) await this.writeEula(directory, actor);
    await this.activity.event(id, "server.created", `Server "${input.name}" created (${provider.label} ${input.mcVersion})`, { actor });
    await this.activity.audit(actor, "server.create", id, { name: input.name, software: input.software, version: input.mcVersion });
    void this.install(id, actor);
    return row;
  }

  private progress(p: InstallProgress) {
    this.hub.broadcast({ type: "install", progress: p });
  }

  /** Download server software and a compatible Java runtime. Safe to retry. */
  async install(id: string, actor: Actor = SYSTEM_ACTOR): Promise<void> {
    if (this.installs.has(id)) return;
    const ac = new AbortController();
    this.installs.set(id, ac);
    try {
      await this.withLock(id, "install", async () => {
        const row = await this.row(id);
        await this.db.update(servers).set({ installState: "installing", installError: null, updatedAt: Date.now() }).where(eq(servers.id, id));
        this.hub.broadcast({ type: "status", serverId: id, status: "installing" });
        const report = (stage: string, p: { received: number; total: number | null } | null) =>
          this.progress({ serverId: id, stage, message: stage, percent: p && p.total ? Math.round((p.received / p.total) * 100) : null });

        const provider = getProvider(row.software);
        const result = await provider.install({ directory: row.directory, version: row.mcVersion, build: row.build, onProgress: report, signal: ac.signal });
        report("Checking Java runtime", null);
        const javaPath = await this.ensureJava(row.javaMajor, row.javaPath, report, ac.signal);
        await this.db
          .update(servers)
          .set({ installState: "installed", jarFile: result.jarFile, jarSha: result.sha, build: result.build, javaPath, installError: null, lastStatus: "stopped", updatedAt: Date.now() })
          .where(eq(servers.id, id));
        this.progress({ serverId: id, stage: "Installed", message: "Installation complete", percent: 100, done: true });
        this.hub.broadcast({ type: "status", serverId: id, status: "stopped" });
        await this.activity.event(id, "server.installed", `Installed ${provider.label} ${row.mcVersion}${result.build ? ` build ${result.build}` : ""}`, { actor });
      });
    } catch (err) {
      const message = (err as Error).message;
      await this.db.update(servers).set({ installState: "failed", installError: message, updatedAt: Date.now() }).where(eq(servers.id, id));
      this.progress({ serverId: id, stage: "Failed", message, percent: null, done: true, error: message });
      this.hub.broadcast({ type: "status", serverId: id, status: "error", detail: message });
      await this.activity.event(id, "server.install_failed", `Installation failed: ${message}`, { level: "error", actor });
    } finally {
      this.installs.delete(id);
    }
  }

  /** Resolve a Java executable compatible with `major`, downloading Temurin if necessary. */
  async ensureJava(major: number, preferred: string | null, report?: (stage: string, p: { received: number; total: number | null } | null) => void, signal?: AbortSignal): Promise<string> {
    if (preferred) {
      const info = await inspectJava(preferred);
      if (info && isJavaCompatible(major, info.major)) return preferred;
    }
    const found = await this.java.findCompatible(major);
    if (found) return found.path;
    const installed = await this.java.install(major, (s, p) => report?.(s, p), signal);
    return installed.path;
  }

  async acceptEula(id: string, actor: Actor) {
    const row = await this.row(id);
    await this.writeEula(row.directory, actor);
    await this.db.update(servers).set({ eulaAccepted: true, eulaAcceptedAt: Date.now(), updatedAt: Date.now() }).where(eq(servers.id, id));
    await this.activity.audit(actor, "server.eula_accept", id);
  }

  private async writeEula(directory: string, actor: Actor) {
    await fsp.writeFile(
      path.join(directory, "eula.txt"),
      `#By changing the setting below to TRUE you are indicating your agreement to the EULA (https://aka.ms/MinecraftEULA).\n#Accepted via CraftPanel by ${actor.username ?? "unknown"} on ${new Date().toISOString()}\neula=true\n`,
    );
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(id: string, actor: Actor): Promise<void> {
    await this.withLock(id, "start", async () => {
      const row = await this.row(id);
      if (row.installState !== "installed") throw conflict("The server is not installed yet", row.installState === "failed" ? "Retry the installation from the server overview." : undefined);
      if (!row.eulaAccepted) throw new AppError(409, "eula_required", "You must accept the Minecraft EULA before starting this server", "https://aka.ms/MinecraftEULA");
      if (this.agent.isRunning(id)) throw conflict("The server is already running");
      if (row.lastStatus === "orphaned" && row.pid && (await this.agent.probeOrphan(row.pid)))
        throw conflict("A server process from a previous CraftPanel session is still running", "Stop or kill the orphaned process first.");
      if (!(await isPortAvailable(row.port, row.bindAddress || "0.0.0.0")))
        throw conflict(`Port ${row.port} is already in use`, "Another program (or another server) is using this port. Change it on the Network page.");
      const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
      if (row.memoryMb > totalMb - 256) throw badRequest(`Allocated memory (${row.memoryMb} MB) exceeds this machine's capacity (${totalMb} MB)`);
      const disk = await freeDiskSpace(row.directory);
      if (disk && disk.free < 256 * 1024 ** 2) throw badRequest("Less than 256 MB of disk space is free. Free up space before starting the server.");
      try {
        await fsp.access(path.join(row.directory, row.jarFile ?? "server.jar"));
      } catch {
        throw new AppError(409, "jar_missing", "The server jar is missing", "Reinstall the server software from the server settings.");
      }

      await this.syncManagedProperties(row);
      await this.writeEula(row.directory, actor).catch(() => undefined);
      const { infoCommand } = await this.settings.get();
      await syncInfoPack(row.directory, infoCommand, { software: row.software, mcVersion: row.mcVersion }).catch((err) => this.activity.event(id, "server.info_pack_failed", `Could not update the CraftPanel info datapack: ${(err as Error).message}`, { level: "warn" }));
      const javaPath = await this.ensureJava(row.javaMajor, row.javaPath);
      if (javaPath !== row.javaPath) await this.db.update(servers).set({ javaPath }).where(eq(servers.id, id));

      this.restartRequired.delete(id);
      await this.db.update(servers).set({ desiredRunning: true, lastError: null, lastStatus: "starting", updatedAt: Date.now() }).where(eq(servers.id, id));
      this.agent.start(id, {
        javaPath,
        directory: row.directory,
        jarFile: row.jarFile ?? "server.jar",
        memoryMb: row.memoryMb,
        jvmArgs: row.jvmArgs.trim() ? row.jvmArgs.trim().split(/\s+/) : [],
        software: row.software,
      });
      await this.activity.event(id, "server.start", `Server starting`, { actor });
      await this.activity.audit(actor, "server.start", id);
    });
  }

  async stop(id: string, actor: Actor): Promise<void> {
    const row = await this.row(id);
    await this.db.update(servers).set({ desiredRunning: false }).where(eq(servers.id, id));
    if (!this.agent.isRunning(id)) {
      if (row.lastStatus === "orphaned" && row.pid) return this.stopOrphan(row, actor, false);
      throw conflict("The server is not running");
    }
    await this.activity.audit(actor, "server.stop", id);
    await this.activity.event(id, "server.stop", "Graceful stop requested", { actor });
    void this.agent.stop(id);
  }

  async restart(id: string, actor: Actor): Promise<void> {
    if (this.agent.isRunning(id)) {
      await this.activity.event(id, "server.restart", "Restart requested", { actor });
      const ok = await this.agent.stop(id);
      if (!ok) throw conflict("The server did not stop in time; restart aborted");
    }
    await this.start(id, actor);
  }

  async kill(id: string, actor: Actor): Promise<void> {
    const row = await this.row(id);
    await this.db.update(servers).set({ desiredRunning: false }).where(eq(servers.id, id));
    await this.activity.audit(actor, "server.kill", id);
    if (this.agent.isRunning(id)) {
      this.agent.kill(id);
      await this.activity.event(id, "server.kill", "Process force-terminated", { level: "warn", actor });
      return;
    }
    if (row.lastStatus === "orphaned" && row.pid) return this.stopOrphan(row, actor, true);
    throw conflict("The server is not running");
  }

  /** Stop a process left over from a previous CraftPanel run (no stdin available). */
  private async stopOrphan(row: ServerRow, actor: Actor, force: boolean) {
    const alive = row.pid ? await this.agent.probeOrphan(row.pid) : false;
    if (alive && row.pid) {
      this.agent.terminatePid(row.pid, force);
      for (let i = 0; i < 60 && (await this.agent.probeOrphan(row.pid)); i++) await new Promise((r) => setTimeout(r, 1000));
    }
    await this.db.update(servers).set({ lastStatus: "stopped", pid: null, updatedAt: Date.now() }).where(eq(servers.id, row.id));
    this.hub.broadcast({ type: "status", serverId: row.id, status: "stopped" });
    await this.activity.event(row.id, "server.orphan_stopped", force ? "Orphaned process killed" : "Orphaned process terminated", { actor, level: "warn" });
  }

  sendCommand(id: string, command: string) {
    if (!this.agent.isRunning(id)) throw conflict("The server is not running");
    this.agent.send(id, command);
  }

  /** Make server.properties match the ports/bind address CraftPanel manages. */
  async syncManagedProperties(row: ServerRow) {
    const file = path.join(row.directory, "server.properties");
    let text = "";
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      /* will be created */
    }
    const doc = PropertiesDocument.parse(text);
    doc.set("server-port", String(row.port));
    doc.set("server-ip", row.bindAddress);
    if (doc.get("query.port") === undefined || doc.get("enable-query") !== "true") doc.set("query.port", String(row.port));
    await fsp.writeFile(file, doc.serialize());
  }

  // ---- updates & deletion -------------------------------------------------

  async update(id: string, patch: Partial<Pick<ServerRow, "name" | "description" | "memoryMb" | "jvmArgs" | "javaPath" | "autoStart" | "networkMode" | "bindAddress" | "port">>, actor: Actor) {
    const row = await this.row(id);
    if (patch.port !== undefined && patch.port !== row.port) {
      const others = (await this.rows()).filter((s) => s.id !== id);
      if (others.some((s) => s.port === patch.port)) throw conflict(`Port ${patch.port} is used by another CraftPanel server`);
      if (!this.agent.isRunning(id) && !(await isPortAvailable(patch.port))) throw conflict(`Port ${patch.port} is in use on this machine`);
    }
    if (patch.memoryMb !== undefined) {
      const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
      if (patch.memoryMb > totalMb - 256) throw badRequest(`This machine only has ${totalMb} MB of RAM`);
    }
    if (patch.javaPath) {
      const info = await inspectJava(patch.javaPath);
      if (!info) throw badRequest("That path is not a working Java executable");
      if (!isJavaCompatible(row.javaMajor, info.major)) throw badRequest(`Java ${info.major} is not compatible; Minecraft ${row.mcVersion} needs Java ${row.javaMajor}`);
    }
    await this.db.update(servers).set({ ...patch, updatedAt: Date.now() }).where(eq(servers.id, id));
    const runtimeKeys: (keyof typeof patch)[] = ["memoryMb", "jvmArgs", "javaPath", "port", "bindAddress"];
    if (this.agent.isRunning(id) && runtimeKeys.some((k) => patch[k] !== undefined && patch[k] !== row[k])) this.restartRequired.add(id);
    if (patch.port !== undefined || patch.bindAddress !== undefined) await this.syncManagedProperties(await this.row(id));
    await this.activity.audit(actor, "server.update", id, patch as Record<string, unknown>);
    return this.row(id);
  }

  async delete(id: string, actor: Actor, opts: { deleteFiles: boolean }) {
    await this.withLock(id, "delete", async () => {
      const row = await this.row(id);
      if (this.agent.isRunning(id)) throw conflict("Stop the server before deleting it");
      this.installs.get(id)?.abort();
      if (opts.deleteFiles) {
        // Only remove directories CraftPanel created (marker file present).
        try {
          await fsp.access(path.join(row.directory, MARKER));
          await fsp.rm(row.directory, { recursive: true, force: true });
        } catch {
          throw badRequest("The server directory was not created by CraftPanel; refusing to delete files");
        }
      }
      await this.db.delete(servers).where(eq(servers.id, id));
      this.agent.forget(id);
      this.restartRequired.delete(id);
      await this.activity.event(null, "server.deleted", `Server "${row.name}" deleted${opts.deleteFiles ? " (files removed)" : " (files kept)"}`, { actor, level: "warn" });
      await this.activity.audit(actor, "server.delete", id, { name: row.name, deleteFiles: opts.deleteFiles });
    });
  }

  /** Change server software version (e.g. Vanilla → Paper migration or update). */
  async changeSoftware(id: string, software: "vanilla" | "paper", version: string, build: string | null, actor: Actor) {
    const row = await this.row(id);
    if (this.agent.isRunning(id)) throw conflict("Stop the server first");
    const provider = getProvider(software);
    const javaReq = await provider.javaRequirement(version);
    await this.db
      .update(servers)
      .set({ software, mcVersion: version, build, javaMajor: javaReq.major, installState: "pending", updatedAt: Date.now() })
      .where(eq(servers.id, id));
    await this.activity.event(id, "server.software_changed", `Switching to ${provider.label} ${version}`, { actor });
    await this.activity.audit(actor, "server.change_software", id, { from: `${row.software} ${row.mcVersion}`, to: `${software} ${version}` });
    await this.install(id, actor);
    const after = await this.row(id);
    if (after.installState !== "installed") throw new AppError(500, "install_failed", after.installError ?? "Installation failed");
    // Remove the previous jar when the filename changed.
    if (row.jarFile && after.jarFile !== row.jarFile) await fsp.rm(path.join(row.directory, row.jarFile), { force: true });
  }

  // ---- agent events & recovery ---------------------------------------------

  private wireAgent() {
    this.agent.on("status", async (id, status, detail) => {
      const info = this.agent.info(id);
      this.hub.broadcast({ type: "status", serverId: id, status, detail });
      try {
        await this.db
          .update(servers)
          .set({ lastStatus: status, pid: info.pid, startedAt: info.startedAt, lastError: status === "crashed" || status === "error" ? (detail ?? info.lastError) : null, lastExitCode: info.lastExitCode })
          .where(eq(servers.id, id));
        if (status === "running") await this.activity.event(id, "server.running", "Server is online and accepting players");
        if (status === "stopped") await this.activity.event(id, "server.stopped", "Server stopped");
        if (status === "crashed") await this.activity.event(id, "server.crashed", `Server crashed: ${detail ?? "unknown reason"}`, { level: "error" });
        if (status === "error") await this.activity.event(id, "server.error", detail ?? "Failed to start", { level: "error" });
      } catch {
        /* server may have been deleted */
      }
    });
    this.agent.on("lines", (id, lines) => this.hub.toSubscribers(id, { type: "console", serverId: id, lines }));
    this.agent.on("metrics", (id, metrics) => this.hub.toSubscribers(id, { type: "metrics", serverId: id, metrics }));
    this.agent.on("players", (id, players) => this.hub.broadcast({ type: "players", serverId: id, players }));
    this.agent.on("signal", async (id, sig) => {
      try {
        if (sig.kind === "join") {
          await this.db.insert(playerSessions).values({ serverId: id, name: sig.name, uuid: this.agent.info(id).players.find((p) => p.name === sig.name)?.uuid ?? null, joinedAt: Date.now() });
        } else if (sig.kind === "leave") {
          await this.db.update(playerSessions).set({ leftAt: Date.now() }).where(and(eq(playerSessions.serverId, id), eq(playerSessions.name, sig.name), isNull(playerSessions.leftAt)));
        } else if (sig.kind === "login") {
          await this.db.update(playerSessions).set({ ip: sig.ip }).where(and(eq(playerSessions.serverId, id), eq(playerSessions.name, sig.name), isNull(playerSessions.leftAt)));
        }
      } catch {
        /* ignore */
      }
    });
    this.agent.on("exit", async (id) => {
      await this.db.update(playerSessions).set({ leftAt: Date.now() }).where(and(eq(playerSessions.serverId, id), isNull(playerSessions.leftAt))).catch(() => undefined);
    });
  }

  /**
   * Reconcile persisted state with reality after CraftPanel starts. A DB
   * record saying "running" proves nothing; we check the PID.
   */
  async recover(): Promise<void> {
    for (const row of await this.rows()) {
      if (row.installState === "installing" || row.installState === "pending") {
        await this.db.update(servers).set({ installState: "failed", installError: "Installation was interrupted. Retry the installation." }).where(eq(servers.id, row.id));
        continue;
      }
      const wasActive = ["starting", "running", "stopping", "orphaned"].includes(row.lastStatus);
      if (wasActive && row.pid && (await this.agent.probeOrphan(row.pid))) {
        await this.db.update(servers).set({ lastStatus: "orphaned" }).where(eq(servers.id, row.id));
        await this.activity.event(row.id, "server.orphaned", `A server process (PID ${row.pid}) from a previous CraftPanel session is still running. Console access is unavailable; stop it and start again to regain control.`, { level: "warn" });
        continue;
      }
      if (wasActive) {
        await this.db.update(servers).set({ lastStatus: row.desiredRunning ? "crashed" : "stopped", pid: null, lastError: row.desiredRunning ? "The server stopped while CraftPanel was not running" : null }).where(eq(servers.id, row.id));
        if (row.desiredRunning) await this.activity.event(row.id, "server.lost", "The server was running when CraftPanel last exited and is no longer running", { level: "warn" });
      }
      await this.db.update(playerSessions).set({ leftAt: Date.now() }).where(and(eq(playerSessions.serverId, row.id), isNull(playerSessions.leftAt)));
    }
    for (const row of await this.rows()) {
      if (row.autoStart && row.installState === "installed" && row.eulaAccepted && !this.agent.isRunning(row.id) && row.lastStatus !== "orphaned") {
        this.start(row.id, SYSTEM_ACTOR).catch((err) => this.activity.event(row.id, "server.autostart_failed", `Automatic start failed: ${(err as Error).message}`, { level: "error" }));
      }
    }
  }
}
