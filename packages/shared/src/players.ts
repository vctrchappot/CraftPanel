/**
 * The player profile: everything CraftPanel can say about one player on one server, assembled from its own
 * session log plus the files Minecraft keeps per player (statistics, advancements, player data). Every part
 * that comes from a Minecraft file can be null: the player may never have saved data on this world.
 */

export interface PlayerRosterEntry {
  name: string;
  uuid: string | null;
  online: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  sessions: number;
  playtimeMs: number;
  whitelisted: boolean;
  opLevel: number | null;
  banned: boolean;
}

export interface PlayerSession {
  id: number;
  joinedAt: number;
  leftAt: number | null;
  ip: string | null;
}

export interface PlayerAddress {
  ip: string;
  sessions: number;
  lastSeen: number;
}

export interface PlayerActivity {
  sessions: number;
  playtimeMs: number;
  averageMs: number;
  longestMs: number;
  /** Joins on the busiest weekday (0 = Monday) and hour, for "usually plays …" sentences. */
  peak: { weekday: number; hour: number } | null;
  /** Playtime of the last 30 days, oldest first, one entry per local day: `day` is `YYYY-MM-DD`. */
  daily: { day: string; ms: number }[];
  /** Milliseconds played per weekday (0 = Monday) and hour of day, over all recorded sessions. */
  heat: number[][];
  /** Most recent first. */
  recent: PlayerSession[];
  addresses: PlayerAddress[];
}

export interface CountEntry {
  id: string;
  count: number;
}

export interface PlayerStats {
  /** Minecraft's own play-time counter in ticks (20 per second); may differ from the sessions CraftPanel recorded. */
  playTicks: number | null;
  /** Ticks since the last death. */
  sinceDeathTicks: number | null;
  deaths: number;
  mobKills: number;
  playerKills: number;
  /** In half hearts, as Minecraft counts it divided by ten. */
  damageDealt: number;
  damageTaken: number;
  jumps: number;
  /** Centimetres by way of travel. */
  distances: { id: string; cm: number }[];
  totals: { mined: number; crafted: number; used: number; broken: number; pickedUp: number; dropped: number };
  mined: CountEntry[];
  crafted: CountEntry[];
  used: CountEntry[];
  broken: CountEntry[];
  killed: CountEntry[];
  killedBy: CountEntry[];
  /** Counters worth a line each (fish caught, villagers traded with, …); only non-zero ones. */
  highlights: { id: string; count: number }[];
}

export interface PlayerAdvancements {
  done: number;
  /** Per category (story, nether, end, adventure, husbandry, others), without recipes. */
  categories: { id: string; done: number }[];
  /** Most recent first, at most 30. */
  recent: { id: string; at: number | null }[];
  recipes: number;
}

export interface ItemStack {
  /** Inventory slot as Minecraft numbers it: 0–8 hotbar, 9–35 backpack; 100–103 and -106 in older files. */
  slot: number;
  id: string;
  count: number;
  name?: string;
  enchantments?: { id: string; level: number }[];
  /** Durability used, when the item has taken damage. */
  damage?: number;
}

export interface PlayerState {
  health: number | null;
  food: number | null;
  saturation: number | null;
  xpLevel: number | null;
  /** 0–1 progress to the next level. */
  xpProgress: number | null;
  gameMode: "survival" | "creative" | "adventure" | "spectator" | null;
  dimension: string | null;
  pos: { x: number; y: number; z: number } | null;
  spawn: { x: number; y: number; z: number; dimension: string | null } | null;
  lastDeath: { x: number; y: number; z: number; dimension: string | null } | null;
  selectedSlot: number | null;
  /** Hotbar and backpack, slots 0–35. */
  inventory: ItemStack[];
  /** Boots, leggings, chestplate, helmet. */
  armor: (ItemStack | null)[];
  offhand: ItemStack | null;
  enderChest: ItemStack[];
}

export interface PlayerEvent {
  id: number;
  kind: string;
  level: "info" | "warn" | "error";
  message: string;
  actor: string | null;
  createdAt: number;
}

export interface PlayerProfile {
  name: string;
  uuid: string | null;
  online: boolean;
  onlineSince: number | null;
  whitelisted: boolean;
  opLevel: number | null;
  ban: { reason: string | null; created: string | null; source: string | null } | null;
  firstSeen: number | null;
  lastSeen: number | null;
  activity: PlayerActivity;
  stats: PlayerStats | null;
  advancements: PlayerAdvancements | null;
  state: PlayerState | null;
  events: PlayerEvent[];
  /** The world folder the files were read from. */
  world: string;
  /** When Minecraft last wrote the player's files; they only change on saves and when the player leaves. */
  savedAt: number | null;
}

const WORDS_SMALL = new Set(["of", "the", "and", "in", "on", "to"]);

/** `minecraft:diamond_pickaxe` → "Diamond Pickaxe"; other namespaces keep their name as a prefix. */
export function prettyId(id: string): string {
  const [ns, rest] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : ["minecraft", id];
  const words = rest
    .split(/[/_]/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && WORDS_SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return ns === "minecraft" ? words : `${words} (${ns})`;
}
