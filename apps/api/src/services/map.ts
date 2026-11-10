import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { badRequest, conflict, DEFAULT_MAP_SETTINGS, levelNameSchema, mapSettingsSchema, SOFTWARE_INFO, softwareLabel, type MapSettings, type MapSettingsInput, type MapStatus } from "@craftpanel/shared";
import { directorySize } from "@craftpanel/server-runtime";
import type { ActivityService, Actor } from "./activity";
import type { GameService } from "./game";
import type { ServerRow, ServerService } from "./servers";
import type { SettingsService } from "./settings";
import { coreConf, dimensionOf, mapConf, MAP_PORT_FIRST, MAP_PORT_LAST, pluginConf, renderThreads, webappConf, webserverConf, withManagedBlock, worldMapId } from "./map-config";

/** Everything CraftPanel remembers about a server's map; lives in the server folder so backups carry it. */
interface MapState {
  installedAt: number;
  eulaAcceptedAt: number;
  port: number;
  settings: MapSettings;
  passwordHash: string | null;
  diskLimitHit: boolean;
  paused: boolean;
  rerenderRequired: boolean;
  pageReady: boolean;
}

const STATE_FILE = ".craftpanel-map.json";
const LIMIT_CHECK_MS = 30_000;
const MAP_ID = /^[A-Za-z0-9_-]{1,64}$/;

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

export class MapService {
  private states = new Map<string, { at: number; state: MapState | null }>();
  private sizes = new Map<string, { at: number; bytes: number }>();
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private installing = false;
  private setup = new Map<string, "installing" | "starting" | "preparing">();
  private setupStarted = new Map<string, number>();
  private setupErrors = new Map<string, string>();

  constructor(
    private servers: ServerService,
    private game: GameService,
    private settings: SettingsService,
    private activity: ActivityService,
  ) {
    servers.hooks.beforeStart.push(async (row) => {
      if (this.supportReason(row)) return;
      const state = await this.state(row, true);
      if (state && await this.jar(row)) await this.apply(row, state);
    });
  }

  /** Watches the size of every map's data and pauses rendering at the limit. */
  start() {
    this.timer ??= setInterval(() => void this.enforceLimits().catch(() => undefined), LIMIT_CHECK_MS);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- layout -----------------------------------------------------------------------------

  supportReason(row: ServerRow): string | null {
    const info = SOFTWARE_INFO[row.software];
    if (info.proxy) return `${softwareLabel(row.software)} is a proxy: it has no world to draw. Put the map on the servers behind it.`;
    if (!info.addons) return "Vanilla cannot load plugins. Switch to Paper or Fabric under Settings → Software & version to use the map.";
    return null;
  }

  private requireSupported(row: ServerRow) {
    const reason = this.supportReason(row);
    if (reason) throw conflict(reason);
  }

  private configDir(row: ServerRow) {
    return path.join(row.directory, SOFTWARE_INFO[row.software].addons === "mods" ? "config/bluemap" : "plugins/BlueMap");
  }
  private addonDir(row: ServerRow) {
    return path.join(row.directory, SOFTWARE_INFO[row.software].addons === "mods" ? "mods" : "plugins");
  }
  private dataDir(row: ServerRow) {
    return path.join(row.directory, "bluemap");
  }

  private async jar(row: ServerRow): Promise<string | null> {
    const files = await fsp.readdir(this.addonDir(row)).catch(() => [] as string[]);
    return files.find((f) => /^bluemap.*\.jar$/i.test(f)) ?? null;
  }

  private async mapFiles(row: ServerRow): Promise<{ file: string; enabled: boolean }[]> {
    const dir = path.join(this.configDir(row), "maps");
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    return files.flatMap<{ file: string; enabled: boolean }>((f) => (f.endsWith(".conf") ? [{ file: f, enabled: true }] : f.endsWith(".conf.disabled") ? [{ file: f, enabled: false }] : []));
  }

  // ---- state ------------------------------------------------------------------------------

  async state(row: ServerRow, fresh = false): Promise<MapState | null> {
    const hit = this.states.get(row.id);
    if (hit && !fresh && Date.now() - hit.at < 5000) return hit.state;
    let state: MapState | null = null;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(row.directory, STATE_FILE), "utf8")) as Partial<MapState>;
      const parsed = mapSettingsSchema.safeParse({ ...DEFAULT_MAP_SETTINGS, ...raw.settings });
      if (parsed.success && Number.isInteger(raw.port) && raw.port! >= MAP_PORT_FIRST && raw.port! <= MAP_PORT_LAST &&
          typeof raw.eulaAcceptedAt === "number" && raw.eulaAcceptedAt > 0 &&
          (raw.passwordHash === null || typeof raw.passwordHash === "string")) {
        state = { ...(raw as MapState), settings: parsed.data, paused: raw.paused === true, diskLimitHit: raw.diskLimitHit === true, rerenderRequired: raw.rerenderRequired === true, pageReady: raw.pageReady === true };
      }
    } catch {
      /* not set up */
    }
    this.states.set(row.id, { at: Date.now(), state });
    return state;
  }

  private async save(row: ServerRow, state: MapState) {
    const file = path.join(row.directory, STATE_FILE);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(temp, file);
    this.states.set(row.id, { at: Date.now(), state });
  }

  private async freePort(row: ServerRow): Promise<number> {
    const taken = new Set<number>();
    for (const r of await this.servers.rows()) {
      taken.add(r.port);
      const s = r.id === row.id ? null : await this.state(r);
      if (s) taken.add(s.port);
    }
    for (let port = MAP_PORT_FIRST; port <= MAP_PORT_LAST; port++) {
      if (taken.has(port)) continue;
      const free = await new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      if (free) return port;
    }
    throw conflict(`No free port for the map between ${MAP_PORT_FIRST} and ${MAP_PORT_LAST}`, "Stop programs that use these ports or remove maps you do not need.");
  }

  // ---- status -----------------------------------------------------------------------------

  private async diskBytes(row: ServerRow): Promise<number> {
    const hit = this.sizes.get(row.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.bytes;
    const bytes = await directorySize(this.dataDir(row)).catch(() => 0);
    this.sizes.set(row.id, { at: Date.now(), bytes });
    return bytes;
  }

  private probe(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/settings.json", timeout: 800 }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
          if (body.length > 64 * 1024) req.destroy();
        });
        res.on("end", () => {
          try { resolve(res.statusCode === 200 && Array.isArray(JSON.parse(body).maps)); }
          catch { resolve(false); }
        });
        res.on("error", () => resolve(false));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
  }

  async status(row: ServerRow): Promise<MapStatus> {
    const reason = this.supportReason(row);
    const state = reason ? null : await this.state(row, true);
    const file = reason ? null : await this.jar(row);
    const s = state?.settings ?? DEFAULT_MAP_SETTINGS;
    const running = this.servers.agent.isRunning(row.id) && this.servers.agent.status(row.id) === "running";
    const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    const installed = !!state && !!file;
    const configReady = installed && (await this.mapFiles(row)).length > 0;
    const webserver = installed && running && state ? await this.probe(state.port) : false;
    if (webserver && state && !state.pageReady && !this.servers.busy(row.id)) {
      await this.servers.withLock(row.id, "map ready", async () => {
        const fresh = await this.state(row, true);
        if (fresh) await this.save(row, { ...fresh, pageReady: true });
      });
      state.pageReady = true;
    }
    if (webserver) {
      this.setup.delete(row.id);
      this.setupStarted.delete(row.id);
      this.setupErrors.delete(row.id);
    }
    if (this.setup.has(row.id) && Date.now() - (this.setupStarted.get(row.id) ?? Date.now()) > 10 * 60_000) {
      this.setup.delete(row.id);
      this.setupStarted.delete(row.id);
      this.setupErrors.set(row.id, "BlueMap did not finish loading within 10 minutes. Check the server console and retry activation.");
    }
    if (this.setup.has(row.id) && ["crashed", "error"].includes(this.servers.status(row))) {
      this.setup.delete(row.id);
      this.setupErrors.set(row.id, "The Minecraft server could not start. Check its console, then retry activation.");
    }
    const dashboardAccess = (await this.settings.get()).dashboardAccess;
    const reach = dashboardAccess === "local" ? "this computer" : dashboardAccess === "private" ? "private networks and VPNs" : "anywhere";
    const warnings: string[] = [];
    if (installed) {
      if (row.memoryMb < 3072) warnings.push(`The server has ${(row.memoryMb / 1024).toFixed(1)} GB of memory. Rendering a map takes memory too: 3 GB or more is comfortable.`);
      if (s.access === "public" && s.players) warnings.push("Everyone who opens the public map sees where the players are, including their bases. Turn off live players to avoid that.");
      if (s.access === "public" && !state?.passwordHash) warnings.push("The public map has no password.");
      if (s.access === "public" && reach !== "anywhere") warnings.push(`CraftPanel is reachable from ${reach} only, so that is who can open the public map. Change this in Settings → Remote access.`);
      if (s.radius === 0 && s.detail === "3d") warnings.push("The whole world in 3D can take many gigabytes and hours to render. A radius or 2D keeps it small.");
      if (state?.diskLimitHit) warnings.push(`Rendering is paused: the map data reached its ${s.maxDiskMb} MB limit. Raise the limit or re-render with a smaller area.`);
      if (!configReady) warnings.push(this.servers.agent.isRunning(row.id) ? "BlueMap has not written its settings yet. They apply once it finished loading." : "Start the server once: BlueMap writes its settings on the first start, and the area and quality apply after that.");
    }
    return {
      supported: !reason,
      reason,
      installed,
      pageReady: installed && !!state?.pageReady,
      setupStage: this.setup.get(row.id) ?? null,
      setupError: this.setupErrors.get(row.id) ?? null,
      file,
      settings: s,
      passwordSet: !!state?.passwordHash,
      configReady,
      restartRequired: installed && this.servers.restartRequired.has(row.id),
      serverRunning: running,
      webserver,
      diskBytes: installed ? await this.diskBytes(row) : 0,
      diskLimitHit: !!state?.diskLimitHit,
      paused: !!state?.paused,
      rerenderRequired: !!state?.rerenderRequired,
      url: installed ? `/map/${row.id}/` : null,
      reach,
      threads: renderThreads(s.speed, cores),
      cores,
      memoryMb: row.memoryMb,
      warnings,
    };
  }

  // ---- install, settings, removal ---------------------------------------------------------

  /** Activation owns the complete setup; the optional page stays hidden until the viewer answers. */
  async activate(row: ServerRow, actor: Actor) {
    this.requireSupported(row);
    if (!row.eulaAccepted) throw conflict("Accept the Minecraft server EULA before activating the map");
    if (row.installState !== "installed") throw conflict("Finish installing the Minecraft server before activating the map");
    if (this.setup.has(row.id)) throw conflict("Map activation is already in progress");
    if ([...this.setup.values()].includes("installing")) throw conflict("Another map is being installed. Try again when it finishes.");
    if (["starting", "stopping", "orphaned", "unknown"].includes(this.servers.status(row))) throw conflict("Wait until the server has started or stopped before activating the map");
    this.setup.set(row.id, "installing");
    this.setupStarted.set(row.id, Date.now());
    this.setupErrors.delete(row.id);
    void (async () => {
      await this.servers.withLock(row.id, "map activation", async () => {
        if (this.servers.agent.isRunning(row.id)) {
          await this.servers.stop(row.id, actor);
          if (this.servers.agent.isRunning(row.id)) throw conflict("The server did not stop in time. Map activation was aborted.");
        }
        await this.install(row, actor);
      });
      this.setup.set(row.id, "starting");
      await this.servers.start(row.id, actor);
      this.setup.set(row.id, "preparing");
    })().catch(async (err) => {
      this.setup.delete(row.id);
      this.setupStarted.delete(row.id);
      this.setupErrors.set(row.id, (err as Error).message);
      await this.activity.event(row.id, "map.setup_failed", `Map activation failed: ${(err as Error).message}`, { actor, level: "error" });
    }).catch(() => undefined);
  }

  async install(row: ServerRow, actor: Actor) {
    this.requireSupported(row);
    if (this.servers.agent.isRunning(row.id)) throw conflict("Stop the server before setting up the map");
    if (this.installing) throw conflict("Another map is being installed. Try again when it finishes.");
    this.installing = true;
    try {
      if (!(await this.jar(row))) {
        const files = await fsp.readdir(this.addonDir(row)).catch(() => [] as string[]);
        const disabled = files.find((f) => /^bluemap.*\.jar\.disabled$/i.test(f));
        if (disabled) await this.game.togglePlugin(row, disabled, true, actor);
        else await this.game.installFromModrinth(row, "bluemap", undefined, actor);
      }
      const now = Date.now();
      const old = await this.state(row, true);
      const state: MapState = old ?? { installedAt: now, eulaAcceptedAt: now, port: await this.freePort(row), settings: { ...DEFAULT_MAP_SETTINGS }, passwordHash: null, diskLimitHit: false, paused: false, rerenderRequired: false, pageReady: false };
      await this.save(row, state);
      await this.apply(row, state);
      await this.activity.event(row.id, "map.installed", "Live map (BlueMap) installed", { actor });
      await this.activity.audit(actor, "map.install", row.id, {});
    } finally { this.installing = false; }
  }

  async saveSettings(row: ServerRow, input: MapSettingsInput, actor: Actor) {
    this.requireSupported(row);
    const state = await this.state(row, true);
    if (!state || !(await this.jar(row))) throw conflict("The map is not installed on this server");
    const { password, ...settings } = input;
    let passwordHash = state.passwordHash;
    if (settings.access === "login") passwordHash = null;
    else if (password === "") passwordHash = null;
    else if (password !== undefined) {
      if (password.length < 6) throw badRequest("The map password needs at least 6 characters");
      passwordHash = hashPassword(password);
    }
    const rerender = ["detail", "caves", "visitedOnly"].some((key) => state.settings[key as keyof MapSettings] !== settings[key as keyof MapSettings]);
    const renderChanged = (Object.keys(settings) as (keyof MapSettings)[]).some((key) => key !== "access" && state.settings[key] !== settings[key]);
    const next: MapState = { ...state, settings, passwordHash, rerenderRequired: state.rerenderRequired || rerender };
    // Raising the limit above what is stored, or removing it, lets rendering continue.
    const size = await directorySize(this.dataDir(row)).catch(() => 0);
    const resume = state.diskLimitHit && (settings.maxDiskMb === 0 || size < settings.maxDiskMb * 1024 * 1024);
    if (resume) next.diskLimitHit = false;
    await this.save(row, next);
    this.sizes.delete(row.id);
    await this.apply(row, next);
    if (this.running(row)) {
      if (renderChanged) await this.servers.sendCommand(row.id, "bluemap reload light");
      if (next.paused || next.diskLimitHit) await this.servers.sendCommand(row.id, "bluemap stop");
      else if (resume) await this.servers.sendCommand(row.id, "bluemap start");
    }
    await this.activity.event(row.id, "map.settings", `Live map settings saved (${settings.access === "public" ? "public" : "sign-in required"}, ${settings.radius ? `${settings.radius} blocks` : "whole world"}, ${settings.detail === "3d" ? "3D" : "2D"})`, { actor });
    await this.activity.audit(actor, "map.settings", row.id, { access: settings.access, radius: settings.radius, detail: settings.detail });
  }

  /** Write the managed settings into BlueMap's files. Map files that BlueMap has not created yet are picked up on the next apply. */
  private async apply(row: ServerRow, state: MapState) {
    const dir = this.configDir(row);
    const s = state.settings;
    const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    await fsp.mkdir(path.join(dir, "maps"), { recursive: true });
    const write = async (file: string, lines: string[]) => {
      const p = path.join(dir, file);
      const text = await fsp.readFile(p, "utf8").catch(() => "");
      const next = withManagedBlock(text, lines);
      if (text !== next) await fsp.writeFile(p, next);
    };
    await write("core.conf", coreConf(s, cores, state.eulaAcceptedAt > 0));
    await write("webserver.conf", webserverConf(state.port));
    await write("webapp.conf", webappConf(s));
    await write("plugin.conf", pluginConf(s));
    // Prepare the active world's standard dimensions before the first start, so the render
    // radius and privacy switches already apply when BlueMap begins rendering.
    const parsedLevel = levelNameSchema.safeParse(await this.game.levelName(row));
    if (!parsedLevel.success) throw conflict("Use a simple world folder name in server.properties before activating the map");
    const level = parsedLevel.data;
    for (const [suffix, dimension, sorting] of [["", "overworld", 0], ["_nether", "the_nether", 100], ["_the_end", "the_end", 200]] as const) {
      const id = worldMapId(level, suffix);
      const file = path.join(dir, "maps", `${id}.conf`);
      if (await exists(file)) continue;
      const world = SOFTWARE_INFO[row.software].addons === "plugins" ? `${level}${suffix}` : level;
      await fsp.writeFile(file, `world: ${JSON.stringify(world)}\ndimension: "minecraft:${dimension}"\nname: ${JSON.stringify(id)}\nsorting: ${sorting}\n`);
    }
    const wanted = { overworld: s.overworld, nether: s.nether, end: s.end } as const;
    for (const m of await this.mapFiles(row)) {
      const current = path.join(dir, "maps", m.file);
      const text = await fsp.readFile(current, "utf8");
      const dim = dimensionOf(text);
      const enabled = dim === "other" ? true : wanted[dim];
      const base = m.file.replace(/\.disabled$/, "");
      const target = path.join(dir, "maps", base);
      const next = withManagedBlock(text, mapConf(s, dim, enabled));
      if (text !== next) await fsp.writeFile(current, next);
      if (target !== current) await fsp.rename(current, target);
    }
  }

  async remove(row: ServerRow, deleteData: boolean, actor: Actor) {
    this.requireSupported(row);
    if (this.servers.agent.isRunning(row.id)) throw conflict("Stop the server before removing the map");
    const jar = await this.jar(row);
    if (jar) await this.game.removePlugin(row, jar, actor);
    await fsp.rm(path.join(row.directory, STATE_FILE), { force: true });
    this.states.delete(row.id);
    if (deleteData) {
      await fsp.rm(this.dataDir(row), { recursive: true, force: true });
      await fsp.rm(this.configDir(row), { recursive: true, force: true });
      this.sizes.delete(row.id);
    }
    await this.activity.event(row.id, "map.removed", `Live map removed${deleteData ? " with its data" : ""}`, { actor, level: "warn" });
    await this.activity.audit(actor, "map.remove", row.id, { deleteData });
  }

  // ---- commands ---------------------------------------------------------------------------

  private running(row: ServerRow) {
    return this.servers.agent.isRunning(row.id) && this.servers.agent.status(row.id) === "running";
  }

  async act(row: ServerRow, action: "update" | "rerender" | "pause" | "resume", actor: Actor) {
    this.requireSupported(row);
    const state = await this.state(row, true);
    if (!state || !(await this.jar(row))) throw conflict("The map is not installed on this server");
    if (!this.running(row)) throw conflict("Start the server first: BlueMap renders while it runs");
    if (action === "update") await this.servers.sendCommand(row.id, "bluemap update");
    else if (action === "pause") {
      await this.servers.sendCommand(row.id, "bluemap stop");
      await this.save(row, { ...state, paused: true });
    }
    else if (action === "resume") {
      this.sizes.delete(row.id);
      if (state.settings.maxDiskMb && (await this.diskBytes(row)) >= state.settings.maxDiskMb * 1024 ** 2)
        throw conflict("The map has reached its disk limit. Raise the limit before resuming.");
      await this.servers.sendCommand(row.id, "bluemap start");
      await this.save(row, { ...state, diskLimitHit: false, paused: false });
    } else {
      const allowed = await this.allowedMaps(row);
      for (const m of await this.mapFiles(row)) {
        const id = m.file.replace(/\.conf(\.disabled)?$/, "");
        if (allowed.includes(id) && MAP_ID.test(id)) await this.servers.sendCommand(row.id, `bluemap purge ${id}`);
      }
      await this.save(row, { ...state, rerenderRequired: false, diskLimitHit: false });
      if (state.diskLimitHit && !state.paused) await this.servers.sendCommand(row.id, "bluemap start");
    }
    await this.activity.event(row.id, "map.action", `Live map: ${action === "rerender" ? "re-render from scratch" : action}`, { actor });
  }

  async enforceLimits() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const row of await this.servers.rows()) {
        if (this.supportReason(row) || !this.running(row) || this.servers.busy(row.id)) continue;
        await this.servers.withLock(row.id, "map limits", async () => {
          const state = await this.state(row, true);
          if (!state || !(await this.jar(row))) return;
          // Newly discovered custom worlds also receive the dashboard's settings.
          await this.apply(row, state);
          if (state.paused || state.diskLimitHit) {
            await this.servers.sendCommand(row.id, "bluemap stop");
            return;
          }
          if (!state.settings.maxDiskMb) return;
          this.sizes.delete(row.id);
          if ((await this.diskBytes(row)) < state.settings.maxDiskMb * 1024 * 1024) return;
          await this.servers.sendCommand(row.id, "bluemap stop");
          await this.save(row, { ...state, diskLimitHit: true });
          await this.activity.event(row.id, "map.limit", `Map rendering paused: the map data reached its ${state.settings.maxDiskMb} MB limit`, { level: "warn" });
        });
      }
    } finally { this.checking = false; }
  }

  // ---- serving ----------------------------------------------------------------------------

  /** What the proxy needs for one request. Null when the server has no map. */
  async serving(id: string): Promise<{ port: number; settings: MapSettings; passwordHash: string | null; revision: string; allowedMaps: string[] } | null> {
    let row: ServerRow;
    try {
      row = await this.servers.row(id);
    } catch {
      return null;
    }
    if (this.supportReason(row)) return null;
    const state = await this.state(row);
    if (!state || !(await this.jar(row))) return null;
    return { port: state.port, settings: state.settings, passwordHash: state.passwordHash,
      revision: crypto.createHash("sha256").update(JSON.stringify([state.installedAt, state.settings, state.passwordHash])).digest("hex"),
      allowedMaps: await this.allowedMaps(row) };
  }

  private async allowedMaps(row: ServerRow): Promise<string[]> {
    const s = (await this.state(row))?.settings ?? DEFAULT_MAP_SETTINGS;
    const out: string[] = [];
    for (const m of await this.mapFiles(row)) {
      const dim = dimensionOf(await fsp.readFile(path.join(this.configDir(row), "maps", m.file), "utf8"));
      if (m.enabled && (dim === "other" || s[dim])) out.push(m.file.replace(/\.conf$/, ""));
    }
    return out;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
