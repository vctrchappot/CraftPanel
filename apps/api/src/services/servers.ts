import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  AppError,
  applyPresetFlags,
  badRequest,
  conflict,
  createServerSchema,
  notFound,
  parseRotation,
  PRESET_INFO,
  ROTATION_DEFAULT_INTERVAL,
  ROTATION_FILE,
  rotationProblem,
  serializeRotation,
  SOFTWARE_INFO,
  type InstallProgress,
  type MotdRotation,
  type MotdRotationState,
  type ServerDetail,
  type ServerMetrics,
  type ServerSoftware,
  type ServerStatus,
  type ServerSummary,
} from "@craftpanel/shared";
import { eq, playerSessions, servers, and, isNull, type Database } from "@craftpanel/database";
import { ensureLog4jConfig, getProvider, hasOwnLog4jSettings, installModpack, JavaManager, inspectJava, isJavaCompatible, log4shellMitigation } from "@craftpanel/minecraft-providers";
import { PropertiesDocument } from "@craftpanel/config";
import { isPortAvailable } from "@craftpanel/network";
import { detectHost, freeDiskSpace, type RuntimeAgent, localArgsFile, ServerSandbox } from "@craftpanel/server-runtime";
import type { z } from "zod";
import type { Hub } from "../hub";
import type { AppConfig } from "../config";
import { SYSTEM_ACTOR, type ActivityService, type Actor } from "./activity";
import { INFO_PLUGIN_FILE, infoStorageCommand, syncInfoPack, syncInfoPlugin } from "./info-pack";
import { checkIcon, ICON_FILE } from "./server-icon";
import { mergeSplitDimensions, separateDimensionLayout } from "./software-switch";
import { MODPACK_RECORD, ModpackStaging, PENDING_MODPACK } from "./modpacks";
import type { SettingsService } from "./settings";

export type ServerRow = typeof servers.$inferSelect;
const MARKER = ".craftpanel";
/** Samples kept per server for the Performance page: roughly an hour (one every 5 s, one more per tick query). */
const METRICS_HISTORY = 1000;

export class ServerService {
  /** Servers whose configuration changed while running. */
  readonly restartRequired = new Set<string>();
  private locks = new Map<string, string>();
  private installs = new Map<string, AbortController>();
  /** Sampled metrics of the current or last run; sampling only happens while a dashboard is open, so this can have gaps. */
  private metricSeries = new Map<string, ServerMetrics[]>();
  /** When each server's icon file was last seen to change, kept for a few seconds so list polling doesn't touch the disk every time. */
  private iconSeen = new Map<string, { at: number; version: number | null }>();
  readonly modpacks: ModpackStaging;
  /** Extension points (the proxy service writes Velocity and backend configuration here). */
  readonly hooks = {
    created: [] as ((row: ServerRow, input: z.output<typeof createServerSchema>) => Promise<void>)[],
    beforeStart: [] as ((row: ServerRow) => Promise<void>)[],
    /** Runs first in every start, before the port is checked (a sleeping server's wake listener lets go of it here). */
    prepareStart: [] as ((id: string) => Promise<void>)[],
    deleted: [] as ((id: string) => Promise<void>)[],
  };

  constructor(
    private db: Database,
    readonly agent: RuntimeAgent,
    private hub: Hub,
    private activity: ActivityService,
    readonly java: JavaManager,
    private config: AppConfig,
    private settings: SettingsService,
    private prepareRuntimeAccess: (directory: string, javaPath: string) => Promise<void> = async () => undefined,
  ) {
    this.modpacks = new ModpackStaging(config.layout.tmp);
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
    if (!this.agent.connected) return "unknown";
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
      iconVersion: this.iconVersion(row),
    };
  }

  /** The icon file's modification time (changes whenever the picture does), or null when the server has no icon. */
  iconVersion(row: ServerRow): number | null {
    const seen = this.iconSeen.get(row.id);
    if (seen && Date.now() - seen.at < 3_000) return seen.version;
    let version: number | null = null;
    try {
      // A fixed file name inside the server's own folder; nothing user-supplied reaches this path.
      version = Math.round(fs.statSync(path.join(row.directory, ICON_FILE)).mtimeMs);
    } catch {
      version = null;
    }
    this.iconSeen.set(row.id, { at: Date.now(), version });
    return version;
  }

  async openIcon(row: ServerRow) {
    if (!(await this.sandbox(row).exists(ICON_FILE))) throw notFound("Icon");
    return this.sandbox(row).openRead(ICON_FILE);
  }

  async setIcon(row: ServerRow, png: Buffer, actor: Actor) {
    checkIcon(png);
    const w = await this.sandbox(row).writeStream(ICON_FILE);
    try {
      await new Promise<void>((resolve, reject) => w.stream.once("error", reject).end(png, resolve));
      await w.finalize();
    } catch (err) {
      await w.abort();
      throw err;
    }
    this.iconSeen.delete(row.id);
    // The game reads the icon when it starts.
    if (this.agent.isRunning(row.id)) this.restartRequired.add(row.id);
    await this.activity.audit(actor, "server.icon_set", row.id);
    await this.activity.event(row.id, "config.updated", "Changed the server icon", { actor });
  }

  async removeIcon(row: ServerRow, actor: Actor) {
    if (!(await this.sandbox(row).exists(ICON_FILE))) return;
    await this.sandbox(row).remove(ICON_FILE);
    this.iconSeen.delete(row.id);
    if (this.agent.isRunning(row.id)) this.restartRequired.add(row.id);
    await this.activity.audit(actor, "server.icon_remove", row.id);
    await this.activity.event(row.id, "config.updated", "Removed the server icon", { actor });
  }

  /** Rotating messages need a plugin loader that can answer the server list ping: Paper and Purpur. */
  private supportsRotation(row: ServerRow): boolean {
    const info = SOFTWARE_INFO[row.software];
    return info.addons === "plugins" && !info.proxy;
  }

  async rotation(row: ServerRow): Promise<MotdRotationState> {
    const supported = this.supportsRotation(row);
    const text = supported ? await this.sandbox(row).readTextIfExists(ROTATION_FILE) : null;
    return { supported, ...(text ? parseRotation(text) : { interval: ROTATION_DEFAULT_INTERVAL, frames: [] }) };
  }

  /**
   * Save the messages the server list shows in turn. The CraftPanel plugin reads the file again whenever it changes, so
   * edits apply at once; the first time the plugin has to be installed and loaded, which needs a start.
   */
  async setRotation(row: ServerRow, rotation: MotdRotation, actor: Actor) {
    if (!this.supportsRotation(row)) throw badRequest("Rotating messages need Paper or Purpur", "Vanilla, Fabric and NeoForge can only show the one message of server.properties.");
    const problem = rotationProblem(rotation);
    if (problem) throw badRequest(problem);
    const sandbox = this.sandbox(row);
    if (rotation.frames.length) await sandbox.writeText(ROTATION_FILE, serializeRotation(rotation));
    else if (await sandbox.exists(ROTATION_FILE)) await sandbox.remove(ROTATION_FILE);
    // A plugin the running server has loaded is left alone (replacing its jar can break it); a missing one is added.
    const running = this.agent.isRunning(row.id);
    if (!running || !(await sandbox.exists(`plugins/${INFO_PLUGIN_FILE}`))) {
      const infoCommand = row.infoCommand ?? (await this.settings.get()).infoCommand;
      const changed = await syncInfoPlugin(row.directory, infoCommand || rotation.frames.length > 0, undefined, infoCommand);
      if (changed && running) this.restartRequired.add(row.id);
    }
    await this.activity.audit(actor, "server.motd_rotation", row.id);
    await this.activity.event(row.id, "config.updated", rotation.frames.length ? `Set ${rotation.frames.length} rotating server list messages` : "Removed the rotating server list messages", { actor });
  }

  detail(row: ServerRow): ServerDetail {
    const info = this.agent.info(row.id);
    return {
      ...this.summary(row),
      directory: row.directory,
      infoCommand: row.infoCommand,
      javaMajor: row.javaMajor,
      javaPath: row.javaPath,
      jvmArgs: row.jvmArgs,
      bindAddress: row.bindAddress,
      log4shell: this.log4shell(row)?.description ?? null,
      pid: info.pid ?? (row.lastStatus === "orphaned" ? row.pid : null),
      exitCode: info.lastExitCode ?? row.lastExitCode,
      lastError: info.lastError ?? row.lastError,
      players: info.players,
    };
  }

  /** Log4Shell protection CraftPanel adds on start, unless the user set their own log4j options. */
  private log4shell(row: Pick<ServerRow, "mcVersion" | "jvmArgs">) {
    const m = log4shellMitigation(row.mcVersion);
    return m && !hasOwnLog4jSettings(splitArgs(row.jvmArgs)) ? m : null;
  }

  sandbox(row: ServerRow) {
    return new ServerSandbox(row.directory);
  }

  // ---- creation & installation -------------------------------------------

  async create(input: z.output<typeof createServerSchema>, actor: Actor): Promise<ServerRow> {
    const id = crypto.randomUUID();
    const pack = input.modpackId ? await this.modpacks.get(input.modpackId) : null;
    if (pack) input = { ...input, software: pack.info.software, mcVersion: pack.info.mcVersion, build: pack.info.loader };
    const provider = getProvider(input.software);
    const versions = await provider.listVersions();
    if (!versions.some((v) => v.id === input.mcVersion)) throw badRequest(`${provider.label} does not offer Minecraft ${input.mcVersion}`);
    const javaReq = await provider.javaRequirement(input.mcVersion);

    const totalMb = Math.floor(detectHost().memoryBytes / 1024 / 1024);
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
    if (pack) await this.modpacks.claim(pack.id, directory);

    const proxy = SOFTWARE_INFO[input.software].proxy;
    // Initial server.properties from the wizard; Minecraft fills in the rest on first start. A proxy has none.
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
    if (input.performancePreset) {
      set("view-distance", PRESET_INFO[input.performancePreset].viewDistance);
      set("simulation-distance", PRESET_INFO[input.performancePreset].simulationDistance);
    }
    if (!proxy) await fsp.writeFile(path.join(directory, "server.properties"), "#Created by CraftPanel\n" + props.serialize());

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
        jvmArgs: input.performancePreset ? applyPresetFlags(input.jvmArgs, input.performancePreset, input.memoryMb) : input.jvmArgs,
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
    if (input.acceptEula && !proxy) await this.writeEula(directory, actor);
    for (const hook of this.hooks.created) await hook(row, input);
    const from = pack ? `, modpack ${pack.info.name} ${pack.info.version}` : "";
    await this.activity.event(id, "server.created", `Server "${input.name}" created (${provider.label} ${input.mcVersion}${from})`, { actor });
    await this.activity.audit(actor, "server.create", id, { name: input.name, software: input.software, version: input.mcVersion, ...(pack ? { modpack: `${pack.info.name} ${pack.info.version}` } : {}) });
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
        // Java first: installers such as NeoForge's run on it.
        report("Checking Java runtime", null);
        const javaPath = await this.ensureJava(row.javaMajor, row.javaPath, report, ac.signal);
        const result = await provider.install({ directory: row.directory, version: row.mcVersion, build: row.build, javaPath, onProgress: report, signal: ac.signal });
        const log4j = this.log4shell(row);
        if (log4j?.configFile) {
          report("Downloading Log4Shell protection", null);
          await ensureLog4jConfig(row.directory, log4j.configFile, ac.signal);
        }
        await this.installPendingModpack(row, actor, ac.signal);
        // Publish installation completion only after the process owner has accepted its boot policy.
        // Otherwise the Start button can race the still-held install lock during Java inspection/IPC.
        if (this.agent.connected) await this.registerRuntime({ ...row, installState: "installed", jarFile: result.jarFile, javaPath }, javaPath);
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

  /**
   * Download a new server's modpack files (kept as PENDING_MODPACK until they are in place, so a
   * retried installation picks it up again). A pack's overrides may bring their own server.properties
   * or eula.txt; the network settings, the EULA decision and CraftPanel's marker are kept.
   */
  private async installPendingModpack(row: ServerRow, actor: Actor, signal: AbortSignal) {
    const sb = this.sandbox(row);
    if (!(await sb.exists(PENDING_MODPACK))) return;
    const keep = async (rel: string) => [rel, await sb.readTextIfExists(rel)] as const;
    const before = await Promise.all([keep("server.properties"), keep("eula.txt"), keep(MARKER)]);
    const record = JSON.parse((await sb.readTextIfExists(MODPACK_RECORD)) ?? "{}") as { name?: string; version?: string };
    const result = await installModpack(
      await sb.resolve(PENDING_MODPACK),
      await sb.resolve("."),
      (rel) => sb.resolve(rel),
      (p) => this.progress({ serverId: row.id, stage: p.stage, message: `${p.stage} (${p.done}/${p.total})`, percent: p.total ? Math.round((p.done / p.total) * 100) : null }),
      signal,
    );
    for (const [rel, text] of before) {
      const now = await sb.readTextIfExists(rel);
      if (text === null || now === text) continue;
      if (rel !== "server.properties" || now === null) {
        await sb.writeText(rel, text);
        continue;
      }
      const ours = PropertiesDocument.parse(text);
      const theirs = PropertiesDocument.parse(now);
      for (const k of ["server-port", "server-ip", "query.port", "enable-rcon", "level-name"]) {
        const v = ours.get(k);
        if (v !== undefined) theirs.set(k, v);
      }
      await sb.writeText(rel, theirs.serialize());
    }
    await sb.writeText(MODPACK_RECORD, JSON.stringify({ ...record, installedAt: new Date().toISOString() }, null, 2));
    await sb.remove(PENDING_MODPACK);
    await this.activity.event(row.id, "server.modpack_installed", `Installed modpack ${record.name ?? ""} ${record.version ?? ""}: ${result.files} files, ${result.overrides} from overrides`.replace(/\s+/g, " "), { actor });
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

  /** Persist next-boot policy even for a server that has never been started. */
  private async registerRuntime(row: ServerRow, resolvedJava?: string) {
    if (row.installState !== "installed" || !row.eulaAccepted) return;
    if (!this.agent.connected) throw new AppError(503, "runtime_disconnected", "Reconnect the Minecraft runtime before changing its configuration");
    if (!this.agent.identity) return; // Embedded test agent has no boot policy to persist.
    const javaPath = resolvedJava ?? await this.ensureJava(row.javaMajor, row.javaPath);
    await this.prepareRuntimeAccess(row.directory, javaPath);
    const log4j = this.log4shell(row);
    await this.agent.configure(row.id, { javaPath, directory: row.directory, jarFile: row.jarFile ?? "server.jar", memoryMb: row.memoryMb,
      jvmArgs: [...(log4j?.jvmArgs ?? []), ...splitArgs(row.jvmArgs)], software: row.software, autoStart: row.autoStart });
  }

  async start(id: string, actor: Actor): Promise<void> {
    await this.withLock(id, "start", async () => {
      for (const hook of this.hooks.prepareStart) await hook(id);
      const row = await this.row(id);
      if (row.installState !== "installed") throw conflict("The server is not installed yet", row.installState === "failed" ? "Retry the installation from the server overview." : undefined);
      if (!row.eulaAccepted) throw new AppError(409, "eula_required", "You must accept the Minecraft EULA before starting this server", "https://aka.ms/MinecraftEULA");
      if (this.agent.isRunning(id)) throw conflict("The server is already running");
      if (row.lastStatus === "orphaned" && row.pid && (await this.agent.probeOrphan(row.pid)))
        throw conflict("A server process from a previous CraftPanel session is still running", "Stop or kill the orphaned process first.");
      if (!(await isPortAvailable(row.port, row.bindAddress || "0.0.0.0")))
        throw conflict(`Port ${row.port} is already in use`, "Another program (or another server) is using this port. Change it on the Network page.");
      const totalMb = Math.floor(detectHost().memoryBytes / 1024 / 1024);
      if (row.memoryMb > totalMb - 256) throw badRequest(`Allocated memory (${row.memoryMb} MB) exceeds this machine's capacity (${totalMb} MB)`);
      const disk = await freeDiskSpace(row.directory);
      if (disk && disk.free < 256 * 1024 ** 2) throw badRequest("Less than 256 MB of disk space is free. Free up space before starting the server.");
      try {
        await fsp.access(path.join(row.directory, localArgsFile(row.jarFile ?? "server.jar")));
      } catch {
        throw new AppError(409, "jar_missing", "The server jar is missing", "Reinstall the server software from the server settings.");
      }

      if (!SOFTWARE_INFO[row.software].proxy) {
        await this.syncManagedProperties(row);
        await this.writeEula(row.directory, actor).catch(() => undefined);
        await this.syncInfoCommand(row);
      }
      for (const hook of this.hooks.beforeStart) await hook(row);
      const javaPath = await this.ensureJava(row.javaMajor, row.javaPath);
      await this.prepareRuntimeAccess(row.directory, javaPath);
      if (javaPath !== row.javaPath) await this.db.update(servers).set({ javaPath }).where(eq(servers.id, id));
      const log4j = this.log4shell(row);
      if (log4j?.configFile) {
        try {
          await ensureLog4jConfig(row.directory, log4j.configFile);
        } catch (err) {
          throw new AppError(
            502,
            "log4shell_config",
            `Could not download the Log4Shell protection for Minecraft ${row.mcVersion}: ${(err as Error).message}`,
            "This version is vulnerable without it, so the server was not started. Check the internet connection and try again.",
          );
        }
      }

      this.restartRequired.delete(id);
      await this.db.update(servers).set({ desiredRunning: true, lastError: null, lastStatus: "starting", updatedAt: Date.now() }).where(eq(servers.id, id));
      await this.agent.start(id, {
        javaPath,
        directory: row.directory,
        jarFile: row.jarFile ?? "server.jar",
        memoryMb: row.memoryMb,
        jvmArgs: [...(log4j?.jvmArgs ?? []), ...splitArgs(row.jvmArgs)],
        software: row.software,
        autoStart: row.autoStart,
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
    await this.agent.stop(id);
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
      await this.agent.kill(id);
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
      await this.agent.terminatePid(row.pid, force);
      for (let i = 0; i < 60 && (await this.agent.probeOrphan(row.pid)); i++) await new Promise((r) => setTimeout(r, 1000));
    }
    await this.db.update(servers).set({ lastStatus: "stopped", pid: null, updatedAt: Date.now() }).where(eq(servers.id, row.id));
    this.hub.broadcast({ type: "status", serverId: row.id, status: "stopped" });
    await this.activity.event(row.id, "server.orphan_stopped", force ? "Orphaned process killed" : "Orphaned process terminated", { actor, level: "warn" });
  }

  async sendCommand(id: string, command: string) {
    if (!this.agent.isRunning(id)) throw conflict("The server is not running");
    await this.agent.send(id, command);
  }

  /** Make server.properties match the ports/bind address CraftPanel manages. */
  async syncManagedProperties(row: ServerRow) {
    // A proxy's port lives in velocity.toml, written before every start.
    if (SOFTWARE_INFO[row.software].proxy) return;
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

  /** Install or remove the in-game info command (datapack everywhere, /craftpanel plugin on Paper). */
  async syncInfoCommand(row: ServerRow) {
    const enabled = row.infoCommand ?? (await this.settings.get()).infoCommand;
    try {
      await syncInfoPack(row.directory, enabled, { software: row.software, mcVersion: row.mcVersion });
      const rotating = (await this.rotation(row)).frames.length > 0;
      await syncInfoPlugin(row.directory, (enabled || rotating) && SOFTWARE_INFO[row.software].addons === "plugins", undefined, enabled);
    } catch (err) {
      await this.activity.event(row.id, "server.info_command_failed", `Could not update the CraftPanel info command: ${(err as Error).message}`, { level: "warn" });
    }
  }

  /**
   * A server that kept running across a CraftPanel update still shows the card it loaded at start. Rewrite the
   * files for its next start and push the current values into the running game.
   */
  private async refreshRunningInfoCommand(row: ServerRow) {
    if (SOFTWARE_INFO[row.software].proxy) return;
    const enabled = row.infoCommand ?? (await this.settings.get()).infoCommand;
    if (!enabled) return;
    const details = { software: row.software, mcVersion: row.mcVersion };
    // Only the datapack: the plugin jar is locked by the running server on Windows and changes rarely.
    await syncInfoPack(row.directory, true, details);
    if (this.agent.status(row.id) === "running") await this.agent.send(row.id, infoStorageCommand(details));
  }

  async update(id: string, patch: Partial<Pick<ServerRow, "name" | "description" | "memoryMb" | "jvmArgs" | "javaPath" | "autoStart" | "networkMode" | "bindAddress" | "port" | "infoCommand">>, actor: Actor) {
    const row = await this.row(id);
    if (patch.port !== undefined && patch.port !== row.port) {
      const others = (await this.rows()).filter((s) => s.id !== id);
      if (others.some((s) => s.port === patch.port)) throw conflict(`Port ${patch.port} is used by another CraftPanel server`);
      if (!this.agent.isRunning(id) && !(await isPortAvailable(patch.port))) throw conflict(`Port ${patch.port} is in use on this machine`);
    }
    if (patch.memoryMb !== undefined) {
      const totalMb = Math.floor(detectHost().memoryBytes / 1024 / 1024);
      if (patch.memoryMb > totalMb - 256) throw badRequest(`This machine only has ${totalMb} MB of RAM`);
    }
    if (patch.javaPath) {
      const info = await inspectJava(patch.javaPath);
      if (!info) throw badRequest("That path is not a working Java executable");
      if (!isJavaCompatible(row.javaMajor, info.major)) throw badRequest(`Java ${info.major} is not compatible; Minecraft ${row.mcVersion} needs Java ${row.javaMajor}`);
    }
    await this.registerRuntime({ ...row, ...patch });
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
      await this.agent.forget(id);
      this.restartRequired.delete(id);
      for (const hook of this.hooks.deleted) await hook(id).catch(() => undefined);
      await this.activity.event(null, "server.deleted", `Server "${row.name}" deleted${opts.deleteFiles ? " (files removed)" : " (files kept)"}`, { actor, level: "warn" });
      await this.activity.audit(actor, "server.delete", id, { name: row.name, deleteFiles: opts.deleteFiles });
    });
  }

  /** Change server software version (e.g. Vanilla → Paper migration or update). */
  async changeSoftware(id: string, software: ServerSoftware, version: string, build: string | null, actor: Actor) {
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
    if (separateDimensionLayout(row.software) && !separateDimensionLayout(software)) {
      for (const m of await mergeSplitDimensions(this.sandbox(row))) {
        await this.activity.event(id, "world.dimension_moved", m.conflict ? `${m.label} of "${m.world}" left in ${m.from}: ${m.to} already has data` : `Moved the ${m.label} of "${m.world}" from ${m.from} to ${m.to}`, { actor, level: m.conflict ? "warn" : "info" });
      }
    }
    // Remove the previous jar when the filename changed (Fabric's launcher starts the vanilla server.jar;
    // NeoForge's argument files live in libraries/, which the installer manages).
    if (row.jarFile && after.jarFile !== row.jarFile && !(software === "fabric" && row.jarFile === "server.jar") && !row.jarFile.endsWith("_args.txt")) await fsp.rm(path.join(row.directory, row.jarFile), { force: true });
    // A NeoForge version change leaves the previous version's own folder behind; libraries it shares stay.
    const oldNeoForge = row.jarFile?.match(/^libraries\/net\/neoforged\/neoforge\/([\w.+-]+)\/(unix|win)_args\.txt$/)?.[1];
    if (oldNeoForge && after.jarFile !== row.jarFile && oldNeoForge !== ".." && oldNeoForge !== ".") await fsp.rm(path.join(row.directory, "libraries", "net", "neoforged", "neoforge", oldNeoForge), { recursive: true, force: true });
  }

  /** Metrics sampled since the server last started, oldest first. */
  metricsHistory(id: string): ServerMetrics[] {
    return this.metricSeries.get(id) ?? [];
  }

  // ---- agent events & recovery ---------------------------------------------

  private wireAgent() {
    this.agent.on("connection", (connected) => {
      void (async () => {
        if (connected) await this.recover();
        for (const row of await this.rows()) {
          if (this.agent.connected !== connected) return;
          this.hub.broadcast({ type: "status", serverId: row.id, status: this.status(row), detail: connected ? undefined : "Runtime connection lost; state is unknown" });
          this.hub.broadcast({ type: "players", serverId: row.id, players: this.agent.info(row.id).players });
          if (connected) {
            this.hub.toSubscribers(row.id, { type: "console", serverId: row.id, lines: this.agent.history(row.id, 1000), replay: true });
            const metrics = this.agent.latestMetrics(row.id);
            if (metrics) this.hub.toSubscribers(row.id, { type: "metrics", serverId: row.id, metrics });
          }
        }
      })().catch(() => undefined);
    });
    this.agent.on("status", async (id, status, detail) => {
      if (status === "starting") this.metricSeries.delete(id);
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
    this.agent.on("metrics", (id, metrics) => {
      const series = this.metricSeries.get(id) ?? [];
      series.push(metrics);
      if (series.length > METRICS_HISTORY) series.splice(0, series.length - METRICS_HISTORY);
      this.metricSeries.set(id, series);
      this.hub.toSubscribers(id, { type: "metrics", serverId: id, metrics });
    });
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
    this.agent.on("exit", async (id, info) => {
      await this.db.update(playerSessions).set({ leftAt: Date.now() }).where(and(eq(playerSessions.serverId, id), isNull(playerSessions.leftAt))).catch(() => undefined);
      // `restart` typed in the console: Paper has no restart script here, so CraftPanel starts the server again itself.
      if (info.restart) {
        await this.activity.event(id, "server.restart", "Restart requested from the console", { actor: SYSTEM_ACTOR }).catch(() => undefined);
        await this.start(id, SYSTEM_ACTOR).catch((err) => this.activity.event(id, "server.error", `Restart failed: ${(err as Error).message}`, { level: "error" }));
      }
    });
  }

  /**
   * Reconcile persisted state with reality after CraftPanel starts. A DB
   * record saying "running" proves nothing; we check the PID.
   */
  async recover(): Promise<void> {
    if (!this.agent.connected) return;
    for (const row of await this.rows()) {
      if (row.installState === "installing" || row.installState === "pending") {
        if (this.installs.has(row.id)) continue; // A transport reconnect did not interrupt this dashboard's installation.
        await this.db.update(servers).set({ installState: "failed", installError: "Installation was interrupted. Retry the installation." }).where(eq(servers.id, row.id));
        continue;
      }
      if (this.agent.owns(row.id)) {
        const info = this.agent.info(row.id);
        await this.db.update(servers).set({ lastStatus: this.agent.status(row.id), pid: info.pid, startedAt: info.startedAt, lastError: info.lastError, lastExitCode: info.lastExitCode }).where(eq(servers.id, row.id));
        const online = new Set(info.players.map((p) => p.name));
        const open = await this.db.select().from(playerSessions).where(and(eq(playerSessions.serverId, row.id), isNull(playerSessions.leftAt)));
        for (const session of open) if (!online.has(session.name)) await this.db.update(playerSessions).set({ leftAt: Date.now() }).where(eq(playerSessions.id, session.id));
        for (const player of info.players) if (!open.some((s) => s.name === player.name)) await this.db.insert(playerSessions).values({ serverId: row.id, name: player.name, uuid: player.uuid, joinedAt: player.joinedAt });
        await this.refreshRunningInfoCommand(row).catch(() => undefined);
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
      if (row.autoStart && row.installState === "installed" && row.eulaAccepted && !this.agent.owns(row.id) && !this.agent.isRunning(row.id) && row.lastStatus !== "orphaned") {
        this.start(row.id, SYSTEM_ACTOR).catch((err) => this.activity.event(row.id, "server.autostart_failed", `Automatic start failed: ${(err as Error).message}`, { level: "error" }));
      } else if (row.installState === "installed" && row.lastStatus !== "orphaned" && !this.agent.owns(row.id)) {
        await this.registerRuntime(row).catch((err) => this.activity.event(row.id, "runtime.registration_failed", `Runtime registration failed: ${(err as Error).message}`, { level: "error" }));
      }
    }
  }
}

function splitArgs(args: string): string[] {
  return args.trim() ? args.trim().split(/\s+/) : [];
}
