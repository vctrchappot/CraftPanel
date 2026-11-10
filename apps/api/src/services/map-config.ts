import type { MapSettings } from "@craftpanel/shared";
import crypto from "node:crypto";

/**
 * BlueMap's own files stay as BlueMap wrote them, comments included. What CraftPanel manages goes into one block
 * at the end of each file; HOCON lets a later key override an earlier one, so the block wins and the rest is untouched.
 */
const BEGIN = "# >>> CraftPanel: managed in the dashboard, this block is rewritten whenever the settings are saved >>>";
const END = "# <<< CraftPanel <<<";
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK = new RegExp(`\\r?\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\r?\\n?`);

export function withManagedBlock(text: string, lines: string[]): string {
  const base = text.replace(BLOCK, "\n").replace(/\s+$/, "");
  return `${base ? `${base}\n\n` : ""}${BEGIN}\n${lines.join("\n")}\n${END}\n`;
}

export function managedBlockOf(text: string): string[] | null {
  const m = BLOCK.exec(text);
  return m ? m[0].split(/\r?\n/).filter((l) => l && l !== BEGIN && l !== END) : null;
}

export const MAP_PORT_FIRST = 8100;
export const MAP_PORT_LAST = 8199;

/** World folders may contain spaces and dots; map ids also appear in console commands and URLs. */
export function worldMapId(world: string, suffix: string): string {
  const safe = world.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const hash = safe === world ? "" : `-${crypto.createHash("sha256").update(world).digest("hex").slice(0, 8)}`;
  return `${safe}${hash}${suffix}`;
}

/** Render threads a speed means on a machine with this many cores; the game keeps the rest. */
export function renderThreads(speed: MapSettings["speed"], cores: number): number {
  const spare = Math.max(1, cores - 1);
  if (speed === "gentle") return 1;
  if (speed === "balanced") return Math.max(1, Math.min(spare, Math.floor(cores / 2)));
  return Math.max(1, Math.min(spare, cores - 1));
}

const q = (s: string) => JSON.stringify(s);

export function coreConf(s: MapSettings, cores: number, acceptDownload: boolean): string[] {
  return [`accept-download: ${acceptDownload}`, `render-thread-count: ${renderThreads(s.speed, cores)}`, "render-thread-priority: 3", "metrics: false"];
}

/** Only the loopback address: CraftPanel serves the map, so nobody reaches BlueMap's own port directly. */
export function webserverConf(port: number): string[] {
  return ["enabled: true", `ip: ${q("127.0.0.1")}`, `port: ${port}`, 'webroot: "bluemap/web"'];
}

/** The browser sandbox gives the map page no cookies or storage, so BlueMap must not try to use them. */
export function webappConf(s: MapSettings): string[] {
  return ["enabled: true", "webroot: \"bluemap/web\"", "update-settings-file: true", "use-cookies: false", 'map-data-root: "maps"', 'live-data-root: "maps"', `default-to-flat-view: ${s.detail === "2d"}`];
}

export function pluginConf(s: MapSettings): string[] {
  return [
    `live-player-markers: ${s.players}`,
    `hide-sneaking: ${s.hideSneaking}`,
    "hide-vanished: true",
    "hide-invisible: true",
    'hidden-game-modes: ["spectator"]',
    `player-render-limit: ${s.pauseAtPlayers || -1}`,
    "full-update-interval: 5",
    "write-players-interval: 0",
  ];
}

/** The part of a map's configuration the dashboard decides: area, detail, caves. */
export function mapConf(s: MapSettings, dimension = "overworld", enabled = true): string[] {
  const lines: string[] = [];
  // Keeping the file prevents BlueMap from generating a replacement for a disabled map.
  if (!enabled) lines.push("world: null");
  const ceiling = dimension === "nether" ? ", max-y: 90" : "";
  if (s.radius > 0) {
    lines.push(`render-mask: [ { min-x: ${s.centerX - s.radius}, max-x: ${s.centerX + s.radius}, min-z: ${s.centerZ - s.radius}, max-z: ${s.centerZ + s.radius}${ceiling} } ]`);
  } else {
    lines.push(dimension === "nether" ? "render-mask: [ { max-y: 90 } ]" : "render-mask: []");
  }
  lines.push(`remove-caves-below-y: ${s.caves || dimension === "nether" || dimension === "end" ? -10000 : 55}`);
  lines.push(`min-inhabited-time: ${s.visitedOnly ? 600 : 0}`);
  if (s.radius > 0) lines.push(`start-pos: { x: ${s.centerX}, z: ${s.centerZ} }`);
  lines.push("enable-flat-view: true", 'storage: "file"');
  if (s.detail === "2d") lines.push("enable-hires: false", "enable-perspective-view: false", "enable-free-flight-view: false");
  else lines.push("enable-hires: true", "enable-perspective-view: true", "enable-free-flight-view: true");
  return lines;
}

/** Which dimension a BlueMap map file renders, from its `dimension:` line. */
export function dimensionOf(mapFile: string): "overworld" | "nether" | "end" | "other" {
  const m = /^\s*dimension:\s*"([^"]+)"/m.exec(mapFile.replace(BLOCK, ""));
  if (!m) return "other";
  if (m[1] === "minecraft:overworld") return "overworld";
  if (m[1] === "minecraft:the_nether") return "nether";
  if (m[1] === "minecraft:the_end") return "end";
  return "other";
}
