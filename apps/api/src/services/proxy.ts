import crypto from "node:crypto";
import { badRequest, conflict, SOFTWARE_INFO, softwareLabel, type ProxyBackendStatus, type ProxyConfig, type ProxyOverview } from "@craftpanel/shared";
import { fabricProxyLiteConfig, paperVelocityConfig, PropertiesDocument, readPaperVelocity, velocityToml } from "@craftpanel/config";
import type { ServerSandbox } from "@craftpanel/server-runtime";
import { SYSTEM_ACTOR, type ActivityService, type Actor } from "./activity";
import type { GameService } from "./game";
import type { ServerRow, ServerService } from "./servers";

/** CraftPanel's record of a proxy's backends, next to velocity.toml. */
const CONFIG = ".craftpanel-proxy.json";
/** Velocity's modern-forwarding secret; backends get the same value. Never logged. */
const SECRET = "forwarding.secret";
export const FABRIC_PROXY_LITE = "8dI2tmqs";
const FABRIC_API = "P7dR8mSH";
const PAPER_GLOBAL = "config/paper-global.yml";
const FABRIC_PROXY_CONFIG = "config/FabricProxy-Lite.toml";

const DEFAULT_CONFIG: ProxyConfig = { backends: [], onlineMode: true, localOnly: true };

/** Paper keeps its Velocity settings in config/paper-global.yml from 1.19 on (26.x included). */
export function paperHasGlobalConfig(mcVersion: string): boolean {
  const [major, minor] = mcVersion.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 19);
}

/** Where the proxy reaches a backend: its own bind address, or this machine. */
export function backendAddress(row: Pick<ServerRow, "bindAddress" | "port">): string {
  const host = row.bindAddress && row.bindAddress !== "0.0.0.0" && row.bindAddress !== "::" ? row.bindAddress : "127.0.0.1";
  return `${host.includes(":") ? `[${host}]` : host}:${row.port}`;
}

/**
 * Velocity networks: which CraftPanel servers sit behind a proxy, velocity.toml for the proxy,
 * and modern forwarding on each backend (Paper's paper-global.yml, FabricProxy-Lite on Fabric).
 */
export class ProxyService {
  constructor(
    private servers: ServerService,
    private game: GameService,
    private activity: ActivityService,
  ) {
    servers.hooks.created.push((row, input) => this.created(row, input.onlineMode, input.motd));
    servers.hooks.beforeStart.push((row) => this.beforeStart(row));
  }

  private requireProxy(row: ServerRow) {
    if (!SOFTWARE_INFO[row.software].proxy) throw conflict("This server is not a proxy");
  }

  async config(row: ServerRow): Promise<ProxyConfig> {
    const text = await this.servers.sandbox(row).readTextIfExists(CONFIG);
    if (!text) return { ...DEFAULT_CONFIG };
    try {
      const raw = JSON.parse(text) as Partial<ProxyConfig>;
      return { backends: Array.isArray(raw.backends) ? raw.backends : [], onlineMode: raw.onlineMode !== false, localOnly: raw.localOnly !== false };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** The forwarding secret, created on first use. */
  private async secret(row: ServerRow): Promise<string> {
    const sb = this.servers.sandbox(row);
    const existing = (await sb.readTextIfExists(SECRET))?.trim();
    if (existing) return existing;
    const secret = crypto.randomBytes(24).toString("base64url");
    await sb.writeText(SECRET, secret);
    return secret;
  }

  private async created(row: ServerRow, onlineMode: boolean, motd: string) {
    if (!SOFTWARE_INFO[row.software].proxy) return;
    const sb = this.servers.sandbox(row);
    await sb.writeText(CONFIG, JSON.stringify({ ...DEFAULT_CONFIG, onlineMode }, null, 2));
    await this.secret(row);
    await sb.writeText("velocity.toml", velocityToml(null, { bind: this.bind(row), onlineMode, servers: [], motd }));
  }

  private bind(row: ServerRow) {
    const host = row.bindAddress || "0.0.0.0";
    return `${host.includes(":") ? `[${host}]` : host}:${row.port}`;
  }

  /** Proxies: rewrite velocity.toml. Backends: re-apply forwarding (port or secret may have changed). */
  private async beforeStart(row: ServerRow) {
    if (SOFTWARE_INFO[row.software].proxy) return this.writeProxy(row, await this.config(row));
    const owner = await this.proxyOf(row.id);
    if (owner) await this.configureBackend(row, owner.config, await this.secret(owner.proxy), null);
  }

  /** The proxy (if any) that lists this server as a backend. */
  private async proxyOf(serverId: string): Promise<{ proxy: ServerRow; config: ProxyConfig } | null> {
    for (const r of await this.servers.rows()) {
      if (!SOFTWARE_INFO[r.software].proxy) continue;
      const config = await this.config(r);
      if (config.backends.some((b) => b.serverId === serverId)) return { proxy: r, config };
    }
    return null;
  }

  private async writeProxy(row: ServerRow, config: ProxyConfig) {
    const sb = this.servers.sandbox(row);
    const rows = new Map((await this.servers.rows()).map((r) => [r.id, r]));
    const servers = config.backends.filter((b) => rows.has(b.serverId)).map((b) => ({ name: b.name, address: backendAddress(rows.get(b.serverId)!), host: b.host }));
    await this.secret(row);
    await sb.writeText("velocity.toml", velocityToml(await sb.readTextIfExists("velocity.toml"), { bind: this.bind(row), onlineMode: config.onlineMode, servers }));
  }

  async overview(row: ServerRow): Promise<ProxyOverview> {
    this.requireProxy(row);
    const config = await this.config(row);
    const secret = await this.secret(row);
    const all = await this.servers.rows();
    const taken = new Set<string>();
    for (const r of all) if (SOFTWARE_INFO[r.software].proxy && r.id !== row.id) for (const b of (await this.config(r)).backends) taken.add(b.serverId);
    const backends: ProxyBackendStatus[] = [];
    for (const b of config.backends) {
      const r = all.find((x) => x.id === b.serverId);
      if (!r) continue;
      backends.push({ ...b, ...(await this.backendStatus(r, secret)), serverName: r.name, software: r.software, port: r.port, bindAddress: r.bindAddress, status: this.servers.agent.status(r.id) ?? r.lastStatus ?? "stopped" });
    }
    const listed = new Set(config.backends.map((b) => b.serverId));
    const candidates = all.filter((r) => !SOFTWARE_INFO[r.software].proxy && !listed.has(r.id) && !taken.has(r.id)).map((r) => ({ id: r.id, name: r.name, software: r.software, port: r.port }));
    return { config, backends, candidates };
  }

  /** How far forwarding is set up on a backend, read from its files. */
  private async backendStatus(r: ServerRow, secret: string): Promise<{ setup: ProxyBackendStatus["setup"]; notes: string[] }> {
    const sb = this.servers.sandbox(r);
    const notes: string[] = [];
    const props = PropertiesDocument.parse((await sb.readTextIfExists("server.properties")) ?? "");
    let configured = false;
    if (r.software === "paper" || r.software === "purpur") {
      const v = readPaperVelocity(await sb.readTextIfExists(PAPER_GLOBAL));
      configured = v.enabled && v.secret === secret && props.get("online-mode") === "false";
    } else if (r.software === "fabric") {
      const mod = (await this.game.plugins(r)).find((p) => p.enabled && /fabricproxy-lite/i.test(`${p.main ?? ""} ${p.file}`));
      if (!mod) notes.push("FabricProxy-Lite is not installed. Save the proxy settings to install it.");
      configured = !!mod && ((await sb.readTextIfExists(FABRIC_PROXY_CONFIG)) ?? "").includes(JSON.stringify(secret)) && props.get("online-mode") === "false";
    } else if (r.software === "neoforge") {
      notes.push("NeoForge needs a forwarding mod such as Proxy Compatible Forge (Modrinth) with the proxy's forwarding secret; CraftPanel doesn't set it up yet.");
      return { setup: "manual", notes };
    }
    if (!configured) return { setup: "manual", notes: [...notes, "Forwarding isn't set up yet; it is applied when you save or when the server starts."] };
    const running = this.servers.agent.isRunning(r.id);
    if (running && this.servers.restartRequired.has(r.id)) return { setup: "restart", notes: [...notes, "Restart this server to apply the proxy settings."] };
    return { setup: "ready", notes };
  }

  /** Save the backend list and apply it to the proxy and every backend. */
  async save(row: ServerRow, next: ProxyConfig, actor: Actor): Promise<ProxyOverview> {
    this.requireProxy(row);
    const rows = new Map((await this.servers.rows()).map((r) => [r.id, r]));
    for (const b of next.backends) {
      const r = rows.get(b.serverId);
      if (!r) throw badRequest("One of the chosen servers no longer exists");
      if (SOFTWARE_INFO[r.software].proxy) throw badRequest(`${r.name} is a proxy itself`);
      if (r.software === "vanilla") throw badRequest(`${r.name} runs Vanilla, which can't receive forwarded players. Switch it to Paper or Fabric first.`);
      if ((r.software === "paper" || r.software === "purpur") && !paperHasGlobalConfig(r.mcVersion)) throw badRequest(`${r.name} runs Minecraft ${r.mcVersion}; CraftPanel sets up Velocity forwarding for Paper 1.19 and newer.`);
      const other = await this.proxyOf(r.id);
      if (other && other.proxy.id !== row.id) throw conflict(`${r.name} is already behind the proxy ${other.proxy.name}`);
    }
    const previous = await this.config(row);
    await this.servers.sandbox(row).writeText(CONFIG, JSON.stringify(next, null, 2));
    await this.writeProxy(row, next);
    const secret = await this.secret(row);
    for (const b of next.backends) await this.configureBackend(rows.get(b.serverId)!, next, secret, actor);
    for (const b of previous.backends) if (!next.backends.some((n) => n.serverId === b.serverId) && rows.has(b.serverId)) await this.releaseBackend(rows.get(b.serverId)!, actor);
    await this.reloadProxy(row);
    await this.activity.audit(actor, "proxy.configure", row.id, { backends: next.backends.map((b) => b.name), onlineMode: next.onlineMode, localOnly: next.localOnly });
    await this.activity.event(row.id, "proxy.configured", `Proxy servers: ${next.backends.map((b) => b.name).join(", ") || "none"}`, { actor });
    return this.overview(row);
  }

  /** Velocity re-reads velocity.toml (servers, try, forced hosts) with "velocity reload". */
  private async reloadProxy(row: ServerRow) {
    if (this.servers.agent.isRunning(row.id) && this.servers.agent.status(row.id) === "running") await this.servers.sendCommand(row.id, "velocity reload");
  }

  /** Turn on modern forwarding with this proxy's secret. `actor` null: before a start (no installs, no restart flags). */
  private async configureBackend(r: ServerRow, config: ProxyConfig, secret: string, actor: Actor | null) {
    const sb = this.servers.sandbox(r);
    let changed = await this.editProperties(sb, (doc) => doc.set("online-mode", "false"));
    if (r.software === "paper" || r.software === "purpur") {
      changed = (await this.editText(sb, PAPER_GLOBAL, (t) => paperVelocityConfig(t, { secret, onlineMode: config.onlineMode }))) || changed;
    } else if (r.software === "fabric") {
      if (actor) changed = (await this.ensureFabricProxy(r, actor)) || changed;
      changed = (await this.editText(sb, FABRIC_PROXY_CONFIG, (t) => fabricProxyLiteConfig(t, { secret, onlineMode: config.onlineMode }))) || changed;
    }
    if (actor && config.localOnly && r.bindAddress !== "127.0.0.1") {
      await this.servers.update(r.id, { bindAddress: "127.0.0.1" }, actor);
      changed = true;
    }
    if (actor && changed && this.servers.agent.isRunning(r.id)) this.servers.restartRequired.add(r.id);
  }

  /** A server taken out of the network: forwarding off, players authenticated by the server again. */
  private async releaseBackend(r: ServerRow, actor: Actor) {
    const sb = this.servers.sandbox(r);
    let changed = await this.editProperties(sb, (doc) => doc.set("online-mode", "true"));
    if (r.software === "paper" || r.software === "purpur") {
      const current = readPaperVelocity(await sb.readTextIfExists(PAPER_GLOBAL));
      if (current.enabled) changed = (await this.editText(sb, PAPER_GLOBAL, (t) => paperVelocityConfig(t, { secret: current.secret ?? "", onlineMode: false, enabled: false }))) || changed;
    } else if (r.software === "fabric") {
      const mod = (await this.game.plugins(r)).find((p) => p.enabled && /fabricproxy-lite/i.test(`${p.main ?? ""} ${p.file}`));
      if (mod) {
        await this.game.togglePlugin(r, mod.file, false, actor);
        changed = true;
      }
    }
    if (r.bindAddress === "127.0.0.1") {
      await this.servers.update(r.id, { bindAddress: "" }, actor);
      changed = true;
    }
    if (changed && this.servers.agent.isRunning(r.id)) this.servers.restartRequired.add(r.id);
    await this.activity.event(r.id, "proxy.removed", "Removed from the proxy; players connect to this server directly again", { actor: actor ?? SYSTEM_ACTOR });
  }

  private async ensureFabricProxy(r: ServerRow, actor: Actor): Promise<boolean> {
    const plugins = await this.game.plugins(r);
    if (plugins.some((p) => p.enabled && /fabricproxy-lite/i.test(`${p.main ?? ""} ${p.file}`))) return false;
    const res = await this.game.installFromModrinth(r, FABRIC_PROXY_LITE, undefined, actor);
    if (res.requiredDependencies.includes(FABRIC_API) && !plugins.some((p) => /fabric api/i.test(p.name ?? ""))) await this.game.installFromModrinth(r, FABRIC_API, undefined, actor);
    return true;
  }

  private async editProperties(sb: ServerSandbox, fn: (doc: PropertiesDocument) => void): Promise<boolean> {
    return this.editText(sb, "server.properties", (t) => {
      const doc = PropertiesDocument.parse(t ?? "");
      fn(doc);
      return doc.serialize();
    });
  }

  private async editText(sb: ServerSandbox, rel: string, fn: (text: string | null) => string): Promise<boolean> {
    const before = await sb.readTextIfExists(rel);
    const after = fn(before);
    if (after === before) return false;
    if (rel.includes("/")) await sb.mkdir(rel.slice(0, rel.lastIndexOf("/")));
    await sb.writeText(rel, after);
    return true;
  }

  /** The secret for the settings page (users with server.configure only). */
  async revealSecret(row: ServerRow): Promise<string> {
    this.requireProxy(row);
    return this.secret(row);
  }

  /** New secret on the proxy and every backend; all of them need a restart. */
  async regenerateSecret(row: ServerRow, actor: Actor): Promise<void> {
    this.requireProxy(row);
    await this.servers.sandbox(row).writeText(SECRET, crypto.randomBytes(24).toString("base64url"));
    const config = await this.config(row);
    const secret = await this.secret(row);
    const rows = new Map((await this.servers.rows()).map((r) => [r.id, r]));
    for (const b of config.backends) if (rows.has(b.serverId)) await this.configureBackend(rows.get(b.serverId)!, config, secret, actor);
    if (this.servers.agent.isRunning(row.id)) this.servers.restartRequired.add(row.id);
    await this.activity.audit(actor, "proxy.secret_regenerated", row.id);
    await this.activity.event(row.id, "proxy.secret_regenerated", `New forwarding secret for ${softwareLabel(row.software)} and its servers; restart them to use it`, { actor, level: "warn" });
  }
}
