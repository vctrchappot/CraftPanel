import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { badRequest, conflict, findInstalledAddon, notFound, SOFTWARE_INFO, softwareLabel, type AddonKind, type GameRuleInfo, type PluginInfo, type WorldInfo } from "@craftpanel/shared";
import { PropertiesDocument, SETTINGS, SETTINGS_BY_KEY, parseJsonList, validateSetting, type BanEntry, type OpEntry, type WhitelistEntry } from "@craftpanel/config";
import { desc, eq, playerSessions, servers as serversTable, type Database } from "@craftpanel/database";
import { createZip, extractZip, listZip, readZipEntry } from "@craftpanel/backup";
import { directorySize } from "@craftpanel/server-runtime";
import {
  baseAddonFile,
  checkModrinthUpdates,
  compatibleModrinthVersions,
  detectGamerules,
  DuplicateAddonError,
  findDuplicateAddon,
  HANGAR_SLUG,
  HANGAR_VERSION_ID,
  hangarVersions,
  inspectAddonJar,
  installHangarVersion,
  installModrinthVersion,
  listAddonMetas,
  listPlugins,
  lookupProfile,
  searchHangarPlugins,
  searchModrinthPlugins,
  type ModLoader,
  toHangarVersion,
} from "@craftpanel/minecraft-providers";
import type { AppConfig } from "../config";
import type { ActivityService, Actor } from "./activity";
import { INFO_PLUGIN_FILE, isInfoPlugin } from "./info-pack";
import type { ServerRow, ServerService } from "./servers";

/** UUID Minecraft assigns to players in offline mode (name-based v3). */
export function offlineUuid(name: string): string {
  const hash = crypto.createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Which jars in plugins/ came from Hangar (project + version), for update checks. */
const HANGAR_INDEX = ".craftpanel-hangar.json";
/** Which jars in plugins/ or mods/ came from Modrinth (project + version), for duplicate detection. */
const MODRINTH_INDEX = ".craftpanel-modrinth.json";
const MODRINTH_ID = /^[A-Za-z0-9_-]{1,64}$/;

const MANAGED_KEYS = new Set(SETTINGS.filter((s) => s.managed).map((s) => s.key));

export class GameService {
  constructor(
    private db: Database,
    private servers: ServerService,
    private activity: ActivityService,
    private config: AppConfig,
  ) {}

  /** Worlds, players, game rules and server.properties belong to Minecraft servers, not to a proxy. */
  private requireGameServer(row: ServerRow) {
    if (SOFTWARE_INFO[row.software].proxy) throw conflict(`${softwareLabel(row.software)} is a proxy: it has no worlds, players or server.properties of its own.`, "Manage those on the servers behind the proxy.");
  }

  private running(row: ServerRow) {
    return this.servers.agent.isRunning(row.id) && this.servers.agent.status(row.id) === "running";
  }

  // ---- server.properties --------------------------------------------------

  async readProperties(row: ServerRow) {
    this.requireGameServer(row);
    const text = (await this.servers.sandbox(row).readTextIfExists("server.properties")) ?? "";
    const doc = PropertiesDocument.parse(text);
    return { raw: text, values: doc.toObject(), catalog: SETTINGS };
  }

  async updateProperties(row: ServerRow, values: Record<string, string>, actor: Actor) {
    this.requireGameServer(row);
    const errors: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (MANAGED_KEYS.has(k)) errors[k] = "Managed by CraftPanel. Change it on the Network or Worlds page.";
      else {
        const e = validateSetting(k, v);
        if (e) errors[k] = e;
      }
    }
    if (Object.keys(errors).length) throw Object.assign(badRequest("Some settings are invalid"), { details: errors });
    const sb = this.servers.sandbox(row);
    const doc = PropertiesDocument.parse((await sb.readTextIfExists("server.properties")) ?? "");
    for (const [k, v] of Object.entries(values)) doc.set(k, v);
    if (values.hardcore === "true") doc.set("difficulty", "hard");
    await sb.writeText("server.properties", doc.serialize());
    if (values["max-players"]) await this.db.update(serversTable).set({ maxPlayers: Number(values["max-players"]) }).where(eq(serversTable.id, row.id));
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.audit(actor, "server.properties_update", row.id, { keys: Object.keys(values) });
    await this.activity.event(row.id, "config.updated", `Updated ${Object.keys(values).length} setting(s)`, { actor });
  }

  /** Replace server.properties from raw text (raw editor / import). */
  async replaceProperties(row: ServerRow, raw: string, actor: Actor) {
    this.requireGameServer(row);
    if (raw.length > 256 * 1024) throw badRequest("File too large");
    const doc = PropertiesDocument.parse(raw);
    const errors: string[] = [];
    for (const [k, v] of Object.entries(doc.toObject())) {
      if (MANAGED_KEYS.has(k)) continue;
      const e = SETTINGS_BY_KEY.has(k) ? validateSetting(k, v) : null;
      if (e) errors.push(`${k}: ${e}`);
    }
    if (errors.length) throw badRequest(`Invalid values — ${errors.slice(0, 5).join("; ")}`);
    await this.servers.sandbox(row).writeText("server.properties", doc.serialize());
    await this.servers.syncManagedProperties(row);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.audit(actor, "server.properties_replace", row.id);
  }

  // ---- gamerules ------------------------------------------------------------

  async gamerules(row: ServerRow): Promise<{ rules: GameRuleInfo[]; live: boolean }> {
    this.requireGameServer(row);
    if (!row.javaPath) throw conflict("Java is not configured for this server yet");
    const defs = await detectGamerules({ mcVersion: row.mcVersion, javaPath: row.javaPath, cacheDir: this.config.layout.cache });
    const live = this.running(row);
    const rules: GameRuleInfo[] = [];
    for (const d of defs) {
      let value: string | null = null;
      if (live) {
        const m = await this.servers.agent.query(row.id, `gamerule ${d.name}`, /(?:currently set to|is set to|is currently)[:\s]+(\S+)\s*$|Incorrect argument for command|Unknown or incomplete command/i, {
          timeoutMs: 2000,
        });
        value = m?.[1] ? m[1].replace(/[."]$/, "") : null;
      }
      rules.push({ ...d, value });
    }
    return { rules, live };
  }

  async setGamerule(row: ServerRow, name: string, value: string, actor: Actor) {
    this.requireGameServer(row);
    if (!this.running(row)) throw conflict("Game rules can only be changed while the server is running");
    const defs = await detectGamerules({ mcVersion: row.mcVersion, javaPath: row.javaPath!, cacheDir: this.config.layout.cache });
    const def = defs.find((d) => d.name === name);
    if (!def) throw badRequest(`Game rule ${name} does not exist in Minecraft ${row.mcVersion}`);
    if (def.type === "boolean" && value !== "true" && value !== "false") throw badRequest("Value must be true or false");
    if (def.type === "integer" && !/^-?\d+$/.test(value)) throw badRequest("Value must be a whole number");
    const m = await this.servers.agent.query(row.id, `gamerule ${name} ${value}`, /is now set to|now set to|Incorrect argument|Invalid|Unknown/i, { timeoutMs: 3000 });
    if (!m || /Incorrect|Invalid|Unknown/i.test(m[0])) throw badRequest(`The server rejected the change${m ? `: ${m[0]}` : ""}`);
    await this.activity.audit(actor, "gamerule.set", row.id, { name, value });
    await this.activity.event(row.id, "gamerule.set", `Game rule ${name} set to ${value}`, { actor });
  }

  // ---- players -------------------------------------------------------------

  async players(row: ServerRow) {
    this.requireGameServer(row);
    const sb = this.servers.sandbox(row);
    const [whitelist, ops, bans, ipBans, props] = await Promise.all([
      sb.readTextIfExists("whitelist.json").then((t) => parseJsonList<WhitelistEntry>(t)),
      sb.readTextIfExists("ops.json").then((t) => parseJsonList<OpEntry>(t)),
      sb.readTextIfExists("banned-players.json").then((t) => parseJsonList<BanEntry>(t)),
      sb.readTextIfExists("banned-ips.json").then((t) => parseJsonList<BanEntry>(t)),
      sb.readTextIfExists("server.properties").then((t) => PropertiesDocument.parse(t ?? "")),
    ]);
    const history = await this.db.select().from(playerSessions).where(eq(playerSessions.serverId, row.id)).orderBy(desc(playerSessions.joinedAt)).limit(200);
    return {
      online: this.servers.agent.info(row.id).players,
      whitelist,
      ops,
      bans,
      ipBans,
      whitelistEnabled: props.get("white-list") === "true",
      onlineMode: props.get("online-mode") !== "false",
      history,
      live: this.running(row),
    };
  }

  private async resolveUuid(row: ServerRow, name: string): Promise<{ uuid: string; name: string }> {
    const props = PropertiesDocument.parse((await this.servers.sandbox(row).readTextIfExists("server.properties")) ?? "");
    if (props.get("online-mode") === "false") return { uuid: offlineUuid(name), name };
    const p = await lookupProfile(name);
    if (!p) throw badRequest(`No Minecraft account named "${name}" exists`);
    return { uuid: p.id, name: p.name };
  }

  private async editList<T extends { name?: string }>(row: ServerRow, file: string, fn: (list: T[]) => T[]) {
    const sb = this.servers.sandbox(row);
    const list = parseJsonList<T>(await sb.readTextIfExists(file));
    await sb.writeText(file, JSON.stringify(fn(list), null, 2));
  }

  async playerAction(row: ServerRow, action: string, name: string, reason: string | undefined, actor: Actor) {
    this.requireGameServer(row);
    const live = this.servers.agent.isRunning(row.id);
    const r = reason?.trim() ? ` ${reason.trim()}` : "";
    const commands: Record<string, string> = {
      "whitelist-add": `whitelist add ${name}`,
      "whitelist-remove": `whitelist remove ${name}`,
      op: `op ${name}`,
      deop: `deop ${name}`,
      kick: `kick ${name}${r}`,
      ban: `ban ${name}${r}`,
      pardon: `pardon ${name}`,
    };
    const cmd = commands[action];
    if (!cmd) throw badRequest("Unknown player action");
    if (live) {
      await this.servers.sendCommand(row.id, cmd);
    } else {
      if (action === "kick") throw conflict("Players can only be kicked while the server is running");
      const lower = name.toLowerCase();
      const same = (e: { name?: string }) => e.name?.toLowerCase() === lower;
      if (action === "whitelist-add" || action === "op" || action === "ban") {
        const p = await this.resolveUuid(row, name);
        if (action === "whitelist-add") await this.editList<WhitelistEntry>(row, "whitelist.json", (l) => (l.some(same) ? l : [...l, { uuid: p.uuid, name: p.name }]));
        if (action === "op") await this.editList<OpEntry>(row, "ops.json", (l) => (l.some(same) ? l : [...l, { uuid: p.uuid, name: p.name, level: 4, bypassesPlayerLimit: false }]));
        if (action === "ban")
          await this.editList<BanEntry>(row, "banned-players.json", (l) =>
            l.some(same) ? l : [...l, { uuid: p.uuid, name: p.name, created: mcDate(), source: `CraftPanel (${actor.username})`, expires: "forever", reason: reason?.trim() || "Banned by an operator." }],
          );
      } else if (action === "whitelist-remove") await this.editList<WhitelistEntry>(row, "whitelist.json", (l) => l.filter((e) => !same(e)));
      else if (action === "deop") await this.editList<OpEntry>(row, "ops.json", (l) => l.filter((e) => !same(e)));
      else if (action === "pardon") await this.editList<BanEntry>(row, "banned-players.json", (l) => l.filter((e) => !same(e)));
    }
    await this.activity.audit(actor, `player.${action}`, row.id, { name, reason });
    await this.activity.event(row.id, `player.${action}`, `${actionLabel(action)} ${name}${reason ? ` (${reason})` : ""}`, { actor });
    // Give the server a moment to persist its JSON lists.
    if (live) await new Promise((r) => setTimeout(r, 400));
  }

  async ipBan(row: ServerRow, ip: string, reason: string | undefined, remove: boolean, actor: Actor) {
    this.requireGameServer(row);
    if (this.servers.agent.isRunning(row.id)) await this.servers.sendCommand(row.id, remove ? `pardon-ip ${ip}` : `ban-ip ${ip}${reason ? ` ${reason}` : ""}`);
    else
      await this.editList<BanEntry>(row, "banned-ips.json", (l) =>
        remove ? l.filter((e) => e.ip !== ip) : l.some((e) => e.ip === ip) ? l : [...l, { ip, created: mcDate(), source: `CraftPanel (${actor.username})`, expires: "forever", reason: reason || "Banned by an operator." }],
      );
    await this.activity.audit(actor, remove ? "player.pardon_ip" : "player.ban_ip", row.id, { ip });
    if (this.servers.agent.isRunning(row.id)) await new Promise((r) => setTimeout(r, 400));
  }

  async setWhitelistEnabled(row: ServerRow, enabled: boolean, actor: Actor) {
    this.requireGameServer(row);
    if (this.servers.agent.isRunning(row.id)) await this.servers.sendCommand(row.id, `whitelist ${enabled ? "on" : "off"}`);
    const sb = this.servers.sandbox(row);
    const doc = PropertiesDocument.parse((await sb.readTextIfExists("server.properties")) ?? "");
    doc.set("white-list", String(enabled));
    await sb.writeText("server.properties", doc.serialize());
    await this.activity.audit(actor, "player.whitelist_toggle", row.id, { enabled });
  }

  // ---- worlds ---------------------------------------------------------------

  private async levelName(row: ServerRow) {
    const doc = PropertiesDocument.parse((await this.servers.sandbox(row).readTextIfExists("server.properties")) ?? "");
    return doc.get("level-name") || "world";
  }

  async worlds(row: ServerRow): Promise<WorldInfo[]> {
    this.requireGameServer(row);
    const active = await this.levelName(row);
    const entries = await fsp.readdir(row.directory, { withFileTypes: true });
    const candidates: { name: string; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const st = await fsp.stat(path.join(row.directory, e.name, "level.dat"));
        candidates.push({ name: e.name, mtime: st.mtimeMs });
      } catch {
        /* not a world */
      }
    }
    const names = new Set(candidates.map((c) => c.name));
    const out: WorldInfo[] = [];
    for (const c of candidates) {
      const base = c.name.replace(/_(nether|the_end)$/, "");
      if (base !== c.name && names.has(base)) continue; // Paper dimension folder, grouped below
      const dims = ["overworld"];
      // Up to 1.21: DIM-1/DIM1 (or Paper's world_nether…); from 26.1: dimensions/minecraft/<name>.
      for (const [dir, label] of [["DIM-1", "nether"], ["DIM1", "the_end"], ["dimensions/minecraft/the_nether", "nether"], ["dimensions/minecraft/the_end", "the_end"]] as const) {
        if (await exists(path.join(row.directory, c.name, dir))) dims.push(label);
      }
      let size = await directorySize(path.join(row.directory, c.name));
      for (const suffix of ["_nether", "_the_end"]) {
        if (names.has(c.name + suffix)) {
          dims.push(suffix.slice(1));
          size += await directorySize(path.join(row.directory, c.name + suffix));
        }
      }
      out.push({ name: c.name, active: c.name === active, size, modifiedAt: c.mtime, dimensions: [...new Set(dims)] });
    }
    // The configured world may not exist yet (generated on next start).
    if (!names.has(active)) out.unshift({ name: active, active: true, size: 0, modifiedAt: 0, dimensions: [] });
    return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  async selectWorld(row: ServerRow, name: string, opts: { seed?: string; levelType?: string }, actor: Actor) {
    this.requireGameServer(row);
    const sb = this.servers.sandbox(row);
    await sb.resolve(name); // validates containment
    const doc = PropertiesDocument.parse((await sb.readTextIfExists("server.properties")) ?? "");
    doc.set("level-name", name);
    if (opts.seed !== undefined) doc.set("level-seed", opts.seed);
    if (opts.levelType) doc.set("level-type", opts.levelType);
    await sb.writeText("server.properties", doc.serialize());
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "world.selected", `Active world set to "${name}"`, { actor });
    await this.activity.audit(actor, "world.select", row.id, { name });
  }

  async createWorld(row: ServerRow, name: string, seed: string | undefined, levelType: string | undefined, activate: boolean, actor: Actor) {
    this.requireGameServer(row);
    const sb = this.servers.sandbox(row);
    if (await sb.exists(name)) throw conflict(`A folder named "${name}" already exists`);
    if (!activate) throw badRequest("New worlds are generated by Minecraft when they become active");
    await this.selectWorld(row, name, { seed: seed ?? "", levelType }, actor);
    await this.activity.event(row.id, "world.created", `New world "${name}" will be generated on next start${seed ? ` (seed ${seed})` : ""}`, { actor });
  }

  private worldFolders(name: string) {
    return [name, `${name}_nether`, `${name}_the_end`];
  }

  async deleteWorld(row: ServerRow, name: string, actor: Actor) {
    this.requireGameServer(row);
    if (this.servers.agent.isRunning(row.id)) throw conflict("Stop the server before deleting a world");
    if ((await this.levelName(row)) === name) throw conflict("You cannot delete the active world. Select a different world first.");
    const sb = this.servers.sandbox(row);
    if (!(await sb.exists(path.posix.join(name, "level.dat")))) throw notFound("World");
    for (const f of this.worldFolders(name)) if (await sb.exists(f)) await sb.remove(f);
    await this.activity.event(row.id, "world.deleted", `World "${name}" deleted`, { actor, level: "warn" });
    await this.activity.audit(actor, "world.delete", row.id, { name });
  }

  /** Export a world (including Paper dimension folders) to a temporary zip. */
  async exportWorld(row: ServerRow, name: string): Promise<string> {
    this.requireGameServer(row);
    const sb = this.servers.sandbox(row);
    if (!(await sb.exists(path.posix.join(name, "level.dat")))) throw notFound("World");
    if (this.running(row)) {
      await this.servers.agent.query(row.id, "save-all flush", /^Saved the (game|world)/i, { timeoutMs: 60000, swallow: /^Saving/i });
    }
    const folders = new Set(this.worldFolders(name));
    const out = path.join(this.config.layout.tmp, `world-${crypto.randomUUID()}.zip`);
    await createZip({
      sourceDir: row.directory,
      destination: out,
      exclude: (rel) => !folders.has(rel.split("/")[0]) || /(^|\/)session\.lock$/.test(rel),
    });
    return out;
  }

  /** Import a world from an uploaded zip (level.dat at the root or inside one folder). */
  async importWorld(row: ServerRow, zipFile: string, name: string, actor: Actor) {
    this.requireGameServer(row);
    const sb = this.servers.sandbox(row);
    if (await sb.exists(name)) throw conflict(`A folder named "${name}" already exists`);
    const entries = await listZip(zipFile);
    const levelDat = entries.map((e) => e.name).filter((n) => /(^|\/)level\.dat$/.test(n)).sort((a, b) => a.length - b.length)[0];
    if (!levelDat) throw badRequest("The archive does not contain a Minecraft world (level.dat not found)");
    const prefix = levelDat.slice(0, -"level.dat".length);
    if (prefix.split("/").filter(Boolean).length > 1) throw badRequest("level.dat is nested too deeply in the archive");
    const target = await sb.resolve(name);
    await extractZip({ file: zipFile, destination: target, stripPrefix: prefix || undefined });
    await this.activity.event(row.id, "world.imported", `World "${name}" imported`, { actor });
    await this.activity.audit(actor, "world.import", row.id, { name });
  }

  // ---- plugins --------------------------------------------------------------

  // Plugins (Paper, Purpur) and mods (Fabric, NeoForge) share these routes; the server's software decides which.

  private pluginsDir(row: ServerRow) {
    return path.join(row.directory, SOFTWARE_INFO[row.software].addons ?? "plugins");
  }

  private requireAddons(row: ServerRow): AddonKind {
    const kind = SOFTWARE_INFO[row.software].addons;
    if (!kind) throw conflict("Vanilla servers cannot load plugins or mods.", "Use the migration assistant on the Plugins page to switch to Paper.");
    return kind;
  }

  private loader(row: ServerRow): ModLoader {
    return row.software === "velocity" ? "velocity" : (SOFTWARE_INFO[row.software].modLoader ?? "fabric");
  }

  /** The Minecraft version add-ons must support; a proxy's version is its own, so nothing is filtered. */
  private gameVersion(row: ServerRow): string | null {
    return SOFTWARE_INFO[row.software].proxy ? null : row.mcVersion;
  }

  private addonLabel(row: ServerRow) {
    return SOFTWARE_INFO[row.software].addons === "mods" ? "Mod" : "Plugin";
  }

  async plugins(row: ServerRow): Promise<PluginInfo[]> {
    const kind = SOFTWARE_INFO[row.software].addons;
    if (!kind) return [];
    const [list, hangar, modrinth] = await Promise.all([
      listPlugins(this.pluginsDir(row), kind, this.loader(row)),
      kind === "plugins" ? this.hangarIndex(row) : Promise.resolve({} as Record<string, { project: string; versionId: string }>),
      this.modrinthIndex(row),
    ]);
    return list.map((p) => {
      const base = baseAddonFile(p.file);
      if (hangar[base]) return { ...p, source: "hangar" as const, projectId: hangar[base].project };
      if (modrinth[base]) return { ...p, source: "modrinth" as const, projectId: modrinth[base].project };
      return p;
    });
  }

  private safePluginFile(file: string) {
    if (!/^[A-Za-z0-9 ._+()-]+\.jar(\.disabled)?$/.test(file)) throw badRequest("Invalid plugin file name");
    return file;
  }

  async togglePlugin(row: ServerRow, file: string, enabled: boolean, actor: Actor) {
    const kind = this.requireAddons(row);
    this.safePluginFile(file);
    const dir = this.pluginsDir(row);
    const base = baseAddonFile(file);
    const from = path.join(dir, file);
    const to = path.join(dir, enabled ? base : `${base}.disabled`);
    if (from === to) return;
    if (!(await exists(from))) throw notFound(this.addonLabel(row));
    if (await exists(to)) throw conflict(`${path.basename(to)} already exists`, "Remove the duplicate file first.");
    if (enabled) {
      const loader = this.loader(row);
      const [candidate, existing] = await Promise.all([inspectAddonJar(from, kind, loader), listAddonMetas(dir, kind, loader)]);
      const dup = findDuplicateAddon(candidate, existing.filter((p) => p.enabled), kind, loader, file);
      if (dup) throw conflict(`${dup.name ?? base} is already enabled (${dup.file})`, "Disable or remove the other copy first.");
    }
    await this.jarOp(row, file, () => fsp.rename(from, to));
    // Disabling/enabling CraftPanel's own info plugin is remembered, so it isn't reinstalled on the next start.
    if (base === INFO_PLUGIN_FILE) await this.servers.update(row.id, { infoCommand: enabled }, actor);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.audit(actor, enabled ? "plugin.enable" : "plugin.disable", row.id, { file: base });
  }

  /** Windows locks the jars a running server has loaded: report that instead of a raw EBUSY/EPERM. */
  private async jarOp<T>(row: ServerRow, file: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && this.servers.agent.isRunning(row.id)) {
        throw conflict(`${file} is in use by the running server`, "Stop the server, then try again. Windows locks the jars a running server has loaded.");
      }
      throw err;
    }
  }

  async removePlugin(row: ServerRow, file: string, actor: Actor) {
    this.requireAddons(row);
    this.safePluginFile(file);
    const isOwnInfoPlugin = baseAddonFile(file) === INFO_PLUGIN_FILE && (await isInfoPlugin(path.join(this.pluginsDir(row), file)));
    await this.jarOp(row, file, () => fsp.rm(path.join(this.pluginsDir(row), file)));
    await Promise.all([this.forgetHangar(row, file), this.forgetModrinth(row, file)]);
    if (isOwnInfoPlugin) await this.servers.update(row.id, { infoCommand: false }, actor);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "plugin.removed", `${this.addonLabel(row)} ${file} removed`, { actor });
    await this.activity.audit(actor, "plugin.remove", row.id, { file });
  }

  /** Validate and move an uploaded jar into plugins/ (or mods/). */
  async installUploadedPlugin(row: ServerRow, tmpFile: string, filename: string, actor: Actor) {
    const kind = this.requireAddons(row);
    const loader = this.loader(row);
    const name = path.basename(filename).replace(/[^A-Za-z0-9 ._+()-]/g, "_");
    if (!name.endsWith(".jar")) throw badRequest(`Only .jar files can be installed as ${kind}`);
    if (kind === "mods" && loader === "neoforge") {
      if (!(await readZipEntry(tmpFile, "META-INF/neoforge.mods.toml").catch(() => null))) throw badRequest("This jar is not a NeoForge mod (no META-INF/neoforge.mods.toml)");
    } else if (kind === "mods") {
      if (!(await readZipEntry(tmpFile, "fabric.mod.json").catch(() => null))) throw badRequest("This jar is not a Fabric mod (no fabric.mod.json)");
    } else if (loader === "velocity") {
      if (!(await readZipEntry(tmpFile, "velocity-plugin.json").catch(() => null))) throw badRequest("This jar is not a Velocity plugin (no velocity-plugin.json)");
    } else {
      const meta = (await readZipEntry(tmpFile, "plugin.yml").catch(() => null)) ?? (await readZipEntry(tmpFile, "paper-plugin.yml").catch(() => null));
      if (!meta) throw badRequest("This jar is not a Bukkit/Paper plugin (no plugin.yml or paper-plugin.yml)");
    }
    const dir = this.pluginsDir(row);
    await fsp.mkdir(dir, { recursive: true });
    const [candidate, existing] = await Promise.all([inspectAddonJar(tmpFile, kind, loader).then((c) => ({ ...c, file: name })), listAddonMetas(dir, kind, loader)]);
    const dup = findDuplicateAddon(candidate, existing, kind, loader);
    if (dup) {
      if (dup.file.toLowerCase() === name.toLowerCase()) throw conflict(`${name} is already installed`);
      throw conflict(`${dup.name ?? candidate.name ?? name} is already installed (${dup.file})`, "Remove or update the existing file first instead of installing a second copy.");
    }
    const dest = path.join(dir, name);
    await fsp.copyFile(tmpFile, dest);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "plugin.installed", `${this.addonLabel(row)} ${name} uploaded`, { actor, level: "warn" });
    await this.activity.audit(actor, "plugin.upload", row.id, { file: name });
  }

  async installFromModrinth(row: ServerRow, projectId: string, versionId: string | undefined, actor: Actor) {
    const kind = this.requireAddons(row);
    const loader = this.loader(row);
    const installed = await this.plugins(row);
    const existingByInput = findInstalledAddon({ id: projectId, slug: projectId, title: projectId, source: "modrinth" }, installed);
    if (existingByInput) {
      throw conflict(
        `${existingByInput.name ?? existingByInput.file} is already installed (${existingByInput.file})`,
        "Use the Updates tab to install a newer version, or remove the existing file first.",
      );
    }
    const versions = await compatibleModrinthVersions(projectId, this.gameVersion(row), kind, loader);
    const chosen = versionId ? versions.find((v) => v.id === versionId) : versions.find((v) => v.version_type === "release") ?? versions[0];
    if (!chosen) throw conflict(`This ${this.addonLabel(row).toLowerCase()} has no version marked compatible with ${SOFTWARE_INFO[row.software].proxy ? "" : `Minecraft ${row.mcVersion} on `}${softwareLabel(row.software)}`);
    const existingByCanonical = installed.find((p) => p.projectId?.toLowerCase() === chosen.project_id.toLowerCase());
    if (existingByCanonical) {
      throw conflict(
        `${existingByCanonical.name ?? existingByCanonical.file} is already installed (${existingByCanonical.file})`,
        "Use the Updates tab to install a newer version, or remove the existing file first.",
      );
    }
    let res;
    try {
      res = await installModrinthVersion(chosen.id, this.pluginsDir(row), { kind, loader });
    } catch (err) {
      if (err instanceof DuplicateAddonError) {
        throw conflict(err.message, "Use the Updates tab to install a newer version, or remove the existing file first.");
      }
      throw err;
    }
    await this.rememberModrinth(row, res.file, res.projectId || projectId, chosen.id);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "plugin.installed", `${this.addonLabel(row)} ${res.file} installed from Modrinth`, { actor });
    await this.activity.audit(actor, "plugin.install", row.id, { projectId: res.projectId || projectId, versionId: chosen.id, file: res.file });
    return { ...res, version: chosen.version_number };
  }

  async searchModrinth(row: ServerRow, query: string, offset: number) {
    const [res, installed] = await Promise.all([
      searchModrinthPlugins(query, this.gameVersion(row), offset, this.requireAddons(row), this.loader(row)),
      this.plugins(row),
    ]);
    return {
      ...res,
      hits: res.hits.map((h) => {
        const match = findInstalledAddon(h, installed);
        return { ...h, installed: !!match, installedVersion: match?.version ?? null, installedFile: match?.file ?? null };
      }),
    };
  }

  async modrinthVersions(row: ServerRow, projectId: string) {
    return compatibleModrinthVersions(projectId, this.gameVersion(row), this.requireAddons(row), this.loader(row));
  }

  private modrinthIndexFile(row: ServerRow) {
    return path.join(this.pluginsDir(row), MODRINTH_INDEX);
  }

  private async modrinthIndex(row: ServerRow): Promise<Record<string, { project: string; versionId: string }>> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.modrinthIndexFile(row), "utf8")) as Record<string, { project?: unknown; versionId?: unknown }>;
      const out: Record<string, { project: string; versionId: string }> = {};
      for (const [file, e] of Object.entries(raw)) {
        if (typeof e?.project === "string" && MODRINTH_ID.test(e.project) && typeof e.versionId === "string" && MODRINTH_ID.test(e.versionId)) {
          out[file] = { project: e.project, versionId: e.versionId };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private async rememberModrinth(row: ServerRow, file: string, project: string, versionId: string) {
    const index = await this.modrinthIndex(row);
    index[baseAddonFile(file)] = { project, versionId };
    await fsp.writeFile(this.modrinthIndexFile(row), JSON.stringify(index, null, 2));
  }

  private async forgetModrinth(row: ServerRow, file: string) {
    const index = await this.modrinthIndex(row);
    const key = baseAddonFile(file);
    if (!(key in index)) return;
    delete index[key];
    await fsp.writeFile(this.modrinthIndexFile(row), JSON.stringify(index, null, 2));
  }

  // Hangar (PaperMC's repository): plugin servers only. Hangar can't look files up by hash, so
  // CraftPanel remembers which jars came from there in a small file next to them.

  private requirePluginServer(row: ServerRow) {
    if (this.requireAddons(row) !== "plugins") throw conflict("Hangar hosts Paper plugins; mod servers (Fabric, NeoForge) use mods from Modrinth.");
    if (SOFTWARE_INFO[row.software].proxy) throw conflict("CraftPanel installs Velocity plugins from Modrinth; Hangar is supported for Paper plugins only.");
  }

  private hangarIndexFile(row: ServerRow) {
    return path.join(this.pluginsDir(row), HANGAR_INDEX);
  }

  private async hangarIndex(row: ServerRow): Promise<Record<string, { project: string; versionId: string }>> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.hangarIndexFile(row), "utf8")) as Record<string, { project?: unknown; versionId?: unknown }>;
      const out: Record<string, { project: string; versionId: string }> = {};
      for (const [file, e] of Object.entries(raw)) if (typeof e?.project === "string" && HANGAR_SLUG.test(e.project) && typeof e.versionId === "string" && HANGAR_VERSION_ID.test(e.versionId)) out[file] = { project: e.project, versionId: e.versionId };
      return out;
    } catch {
      return {};
    }
  }

  private async rememberHangar(row: ServerRow, file: string, project: string, versionId: string) {
    const index = await this.hangarIndex(row);
    index[baseAddonFile(file)] = { project, versionId };
    await fsp.writeFile(this.hangarIndexFile(row), JSON.stringify(index, null, 2));
  }

  private async forgetHangar(row: ServerRow, file: string) {
    const index = await this.hangarIndex(row);
    const key = baseAddonFile(file);
    if (!(key in index)) return;
    delete index[key];
    await fsp.writeFile(this.hangarIndexFile(row), JSON.stringify(index, null, 2));
  }

  async searchHangar(row: ServerRow, query: string, offset: number) {
    this.requirePluginServer(row);
    const [res, installed] = await Promise.all([
      searchHangarPlugins(query, row.mcVersion, offset),
      this.plugins(row),
    ]);
    return {
      ...res,
      hits: res.hits.map((h) => {
        const match = findInstalledAddon(h, installed);
        return { ...h, installed: !!match, installedVersion: match?.version ?? null, installedFile: match?.file ?? null };
      }),
    };
  }

  async hangarVersions(row: ServerRow, project: string) {
    this.requirePluginServer(row);
    if (!HANGAR_SLUG.test(project)) throw badRequest("Invalid Hangar project");
    return (await hangarVersions(project, row.mcVersion)).map(toHangarVersion);
  }

  async installFromHangar(row: ServerRow, project: string, versionId: string | undefined, actor: Actor) {
    this.requirePluginServer(row);
    if (!HANGAR_SLUG.test(project)) throw badRequest("Invalid Hangar project");
    if (versionId && !HANGAR_VERSION_ID.test(versionId)) throw badRequest("Invalid Hangar version");
    const installed = await this.plugins(row);
    const existing = findInstalledAddon({ id: project, slug: project, title: project, source: "hangar" }, installed);
    if (existing) {
      throw conflict(
        `${existing.name ?? project} is already installed (${existing.file})`,
        "Use the Updates tab to install a newer version, or remove the existing plugin first.",
      );
    }
    const chosen = versionId ?? (await hangarVersions(project, row.mcVersion))[0]?.id.toString();
    if (!chosen) throw conflict(`This plugin has no Hangar version marked compatible with Minecraft ${row.mcVersion}`);
    let res;
    try {
      res = await installHangarVersion(chosen, this.pluginsDir(row));
    } catch (err) {
      if (err instanceof DuplicateAddonError) {
        throw conflict(err.message, "Use the Updates tab to install a newer version, or remove the existing plugin first.");
      }
      throw badRequest((err as Error).message);
    }
    await this.rememberHangar(row, res.file, project, chosen);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "plugin.installed", `Plugin ${res.file} installed from Hangar`, { actor });
    await this.activity.audit(actor, "plugin.install", row.id, { source: "hangar", project, versionId: chosen, file: res.file });
    return res;
  }

  async pluginUpdates(row: ServerRow) {
    const kind = this.requireAddons(row);
    const plugins = await listPlugins(this.pluginsDir(row), kind, this.loader(row));
    // Jars installed from Hangar are checked there only; the same jar is often on Modrinth too, with other channels.
    const index = kind === "plugins" ? await this.hangarIndex(row) : {};
    const fromHangar = (p: { file: string }) => index[baseAddonFile(p.file)];
    const updates = await checkModrinthUpdates(plugins.filter((p) => !fromHangar(p)).map((p) => p.sha1), this.gameVersion(row), kind, this.loader(row));
    const out: { file: string; name: string | null; current: string | null; versionId: string; versionNumber: string; projectId: string; source: "modrinth" | "hangar" }[] = plugins
      .filter((p) => !fromHangar(p) && updates[p.sha1])
      .map((p) => ({ file: p.file, name: p.name, current: p.version, ...updates[p.sha1], source: "modrinth" }));
    if (kind === "plugins") {
      await Promise.all(
        plugins.map(async (p) => {
          const known = fromHangar(p);
          if (!known) return;
          const newest = (await hangarVersions(known.project, row.mcVersion).catch(() => []))[0];
          if (newest && String(newest.id) !== known.versionId) out.push({ file: p.file, name: p.name, current: p.version, versionId: String(newest.id), versionNumber: newest.name, projectId: known.project, source: "hangar" });
        }),
      );
    }
    return out;
  }

  async updatePlugin(row: ServerRow, file: string, versionId: string, actor: Actor, source: "modrinth" | "hangar" = "modrinth") {
    const kind = this.requireAddons(row);
    const loader = this.loader(row);
    this.safePluginFile(file);
    const dir = this.pluginsDir(row);
    const known = source === "hangar" ? (await this.hangarIndex(row))[baseAddonFile(file)] : undefined;
    if (source === "hangar" && !known) throw badRequest(`${file} was not installed from Hangar`);
    // Move the old jar aside first: if the running server has it locked, nothing is downloaded and
    // no second copy is left behind; if the install fails, it is put back.
    const current = path.join(dir, file);
    const aside = path.join(dir, `.${file}.${crypto.randomUUID()}.replacing`);
    await this.jarOp(row, file, () => fsp.rename(current, aside));
    let res: { file: string; projectId?: string };
    try {
      res = source === "hangar" ? await installHangarVersion(versionId, dir, { replaceFile: file }) : await installModrinthVersion(versionId, dir, { kind, loader, replaceFile: file });
    } catch (err) {
      await fsp.rename(aside, current).catch(() => {});
      if (err instanceof DuplicateAddonError) throw conflict(err.message);
      if (source === "hangar") throw badRequest((err as Error).message);
      throw err;
    }
    await fsp.rm(aside, { force: true });
    if (source === "hangar") {
      if (res.file !== baseAddonFile(file)) await this.forgetHangar(row, file);
      await this.rememberHangar(row, res.file, known!.project, versionId);
      if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
      await this.activity.event(row.id, "plugin.updated", `${this.addonLabel(row)} ${file} updated to ${res.file}`, { actor });
      await this.activity.audit(actor, "plugin.update", row.id, { source: "hangar", file, versionId });
      return;
    }
    if (res.file !== baseAddonFile(file)) await this.forgetModrinth(row, file);
    await this.rememberModrinth(row, res.file, res.projectId!, versionId);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.event(row.id, "plugin.updated", `${this.addonLabel(row)} ${file} updated to ${res.file}`, { actor });
    await this.activity.audit(actor, "plugin.update", row.id, { file, versionId });
  }
}

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function mcDate() {
  // Minecraft format: 2024-01-31 12:00:00 +0000
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " +0000";
}

function actionLabel(a: string) {
  return (
    { "whitelist-add": "Whitelisted", "whitelist-remove": "Removed from whitelist:", op: "Granted operator to", deop: "Revoked operator from", kick: "Kicked", ban: "Banned", pardon: "Unbanned" } as Record<string, string>
  )[a] ?? a;
}
