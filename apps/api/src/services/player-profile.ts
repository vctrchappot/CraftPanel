import { asList, asNumber, asString, isCompound, type NbtCompound, type NbtValue } from "@craftpanel/config";
import type { CountEntry, ItemStack, PlayerActivity, PlayerAdvancements, PlayerSession, PlayerState, PlayerStats } from "@craftpanel/shared";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A session that never got a leave time is cut here so one stray row can't paint a month of play. */
export const MAX_SESSION_MS = 14 * DAY;
const TOP = 12;

export interface SessionRow {
  id: number;
  joinedAt: number;
  leftAt: number | null;
  ip: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Aggregate recorded sessions. `tzOffsetMin` is the browser's `Date.getTimezoneOffset()`, so the weekday, hour and day
 * buckets follow the viewer's clock rather than the server's.
 */
export function summarizeActivity(rows: SessionRow[], now: number, tzOffsetMin = 0): PlayerActivity {
  const shift = -tzOffsetMin * 60_000;
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const days = new Map<string, number>();
  let total = 0;
  let longest = 0;
  const finished: number[] = [];
  const addresses = new Map<string, { sessions: number; lastSeen: number }>();

  for (const r of rows) {
    const end = Math.min(r.leftAt ?? now, r.joinedAt + MAX_SESSION_MS);
    const ms = Math.max(0, end - r.joinedAt);
    total += ms;
    longest = Math.max(longest, ms);
    if (r.leftAt !== null) finished.push(ms);
    if (r.ip) {
      const a = addresses.get(r.ip) ?? { sessions: 0, lastSeen: 0 };
      a.sessions++;
      a.lastSeen = Math.max(a.lastSeen, r.joinedAt);
      addresses.set(r.ip, a);
    }
    // Split at local hour boundaries: each slice belongs to one weekday-hour cell and one day.
    let t = r.joinedAt;
    while (t < end) {
      const local = new Date(t + shift);
      const next = Math.min(end, t + (HOUR - (((t + shift) % HOUR) + HOUR) % HOUR));
      const slice = next - t;
      const weekday = (local.getUTCDay() + 6) % 7;
      heat[weekday][local.getUTCHours()] += slice;
      const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
      days.set(day, (days.get(day) ?? 0) + slice);
      t = next;
    }
  }

  const today = new Date(now + shift);
  const daily: { day: string; ms: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    daily.push({ day, ms: days.get(day) ?? 0 });
  }

  let peak: PlayerActivity["peak"] = null;
  let best = 0;
  heat.forEach((hours, weekday) => hours.forEach((ms, hour) => ms > best && ((best = ms), (peak = { weekday, hour }))));

  const sessions: PlayerSession[] = [...rows]
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, 30)
    .map((r) => ({ id: r.id, joinedAt: r.joinedAt, leftAt: r.leftAt, ip: r.ip }));

  return {
    sessions: rows.length,
    playtimeMs: total,
    averageMs: finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : 0,
    longestMs: longest,
    peak,
    daily,
    heat,
    recent: sessions,
    addresses: [...addresses].map(([ip, a]) => ({ ip, ...a })).sort((a, b) => b.lastSeen - a.lastSeen),
  };
}

// ---- statistics -----------------------------------------------------------------------------------

type Counters = Record<string, number>;

function counters(v: unknown): Counters {
  const out: Counters = {};
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  return out;
}

const sum = (c: Counters) => Object.values(c).reduce((a, b) => a + b, 0);
const top = (c: Counters, n = TOP): CountEntry[] =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ id, count }));

/** Counters in `minecraft:custom` that deserve a line of their own when non-zero. */
const HIGHLIGHTS = [
  "fish_caught",
  "animals_bred",
  "traded_with_villager",
  "talked_to_villager",
  "enchant_item",
  "sleep_in_bed",
  "open_chest",
  "open_enderchest",
  "raid_win",
  "bell_ring",
  "target_hit",
  "clean_armor",
] as const;

/** The `stats` object of `<world>/stats/<uuid>.json`; null when the file isn't the post-1.13 layout. */
export function normalizeStats(json: unknown): PlayerStats | null {
  const root = json && typeof json === "object" ? (json as { stats?: Record<string, unknown> }).stats : undefined;
  if (!root || typeof root !== "object") return null;
  const custom = counters(root["minecraft:custom"]);
  const c = (k: string) => custom[`minecraft:${k}`] ?? 0;
  const mined = counters(root["minecraft:mined"]);
  const crafted = counters(root["minecraft:crafted"]);
  const used = counters(root["minecraft:used"]);
  const broken = counters(root["minecraft:broken"]);
  const pickedUp = counters(root["minecraft:picked_up"]);
  const dropped = counters(root["minecraft:dropped"]);
  const killed = counters(root["minecraft:killed"]);
  const killedBy = counters(root["minecraft:killed_by"]);

  const distances = Object.entries(custom)
    .filter(([k]) => k.endsWith("_one_cm"))
    .map(([k, cm]) => ({ id: k.replace(/^minecraft:/, "").replace(/_one_cm$/, ""), cm }))
    .sort((a, b) => b.cm - a.cm);

  const playTicks = custom["minecraft:play_time"] ?? custom["minecraft:play_one_minute"] ?? null;
  return {
    playTicks,
    sinceDeathTicks: custom["minecraft:time_since_death"] ?? null,
    deaths: c("deaths"),
    mobKills: c("mob_kills"),
    playerKills: c("player_kills"),
    damageDealt: c("damage_dealt") / 10,
    damageTaken: c("damage_taken") / 10,
    jumps: c("jump"),
    distances,
    totals: { mined: sum(mined), crafted: sum(crafted), used: sum(used), broken: sum(broken), pickedUp: sum(pickedUp), dropped: sum(dropped) },
    mined: top(mined),
    crafted: top(crafted),
    used: top(used),
    broken: top(broken),
    killed: top(killed),
    killedBy: top(killedBy),
    highlights: HIGHLIGHTS.map((id) => ({ id, count: c(id) })).filter((h) => h.count > 0),
  };
}

// ---- advancements ---------------------------------------------------------------------------------

/** "2024-05-01 17:32:10 +0200" as Minecraft writes it. */
export function parseAdvancementTime(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : null;
}

export function normalizeAdvancements(json: unknown): PlayerAdvancements | null {
  if (!json || typeof json !== "object") return null;
  const done: { id: string; at: number | null }[] = [];
  let recipes = 0;
  for (const [id, v] of Object.entries(json as Record<string, unknown>)) {
    if (id === "DataVersion" || !v || typeof v !== "object" || (v as { done?: unknown }).done !== true) continue;
    if (id.startsWith("minecraft:recipes/")) {
      recipes++;
      continue;
    }
    const times = Object.values(stringMap((v as { criteria?: unknown }).criteria))
      .map(parseAdvancementTime)
      .filter((t): t is number => t !== null);
    done.push({ id, at: times.length ? Math.max(...times) : null });
  }
  const byCategory = new Map<string, number>();
  for (const d of done) {
    const [ns, path] = d.id.split(":");
    const cat = ns === "minecraft" ? (path?.split("/")[0] ?? "other") : ns;
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  return {
    done: done.length,
    recipes,
    categories: [...byCategory].map(([id, n]) => ({ id, done: n })).sort((a, b) => b.done - a.done),
    recent: done.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 30),
  };
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === "string") out[k] = s;
  return out;
}

// ---- player data (NBT) ----------------------------------------------------------------------------

const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;
const LEGACY_DIMENSIONS: Record<number, string> = { [-1]: "minecraft:the_nether", 0: "minecraft:overworld", 1: "minecraft:the_end" };

function dimensionOf(v: NbtValue | undefined): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return LEGACY_DIMENSIONS[v] ?? null;
  return null;
}

/** A text component stored as plain text, a JSON string or (1.21.5+) an NBT compound. */
function textOf(v: NbtValue | undefined): string | undefined {
  if (typeof v === "string") {
    try {
      const j: unknown = JSON.parse(v);
      if (typeof j === "string") return j;
      if (j && typeof j === "object" && typeof (j as { text?: unknown }).text === "string") return (j as { text: string }).text || undefined;
    } catch {
      /* plain text */
    }
    return v || undefined;
  }
  if (isCompound(v)) return asString(v.text) ?? undefined;
  return undefined;
}

/** Enchantments as `{id: level}`, wrapped in `levels` before 1.21.5. */
function enchantmentsOf(v: NbtValue | undefined): { id: string; level: number }[] {
  if (!isCompound(v)) return [];
  const map = isCompound(v.levels) ? v.levels : v;
  return Object.entries(map)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .map(([id, level]) => ({ id, level }));
}

export function parseItem(c: NbtValue | undefined, slot: number): ItemStack | null {
  if (!isCompound(c)) return null;
  const id = asString(c.id);
  if (!id || id === "minecraft:air") return null;
  const count = asNumber(c.count) ?? asNumber(c.Count) ?? 1;
  if (count <= 0) return null;
  const item: ItemStack = { slot, id, count };
  const comp = isCompound(c.components) ? c.components : null;
  const legacy = isCompound(c.tag) ? c.tag : null;
  const name = comp ? textOf(comp["minecraft:custom_name"]) : legacy && isCompound(legacy.display) ? textOf(legacy.display.Name) : undefined;
  if (name) item.name = name;
  const ench = comp
    ? [...enchantmentsOf(comp["minecraft:enchantments"]), ...enchantmentsOf(comp["minecraft:stored_enchantments"])]
    : legacy
      ? [...asList(legacy.Enchantments), ...asList(legacy.StoredEnchantments)].flatMap((e) => (isCompound(e) && asString(e.id) && asNumber(e.lvl) !== null ? [{ id: e.id as string, level: e.lvl as number }] : []))
      : [];
  if (ench.length) item.enchantments = ench;
  const damage = comp ? asNumber(comp["minecraft:damage"]) : legacy ? asNumber(legacy.Damage) : null;
  if (damage && damage > 0) item.damage = damage;
  return item;
}

function itemsOf(list: NbtValue | undefined): ItemStack[] {
  return asList(list).flatMap((e) => {
    const slot = isCompound(e) ? asNumber(e.Slot) : null;
    const item = slot === null ? null : parseItem(e, slot);
    return item ? [item] : [];
  });
}

const triple = (v: NbtValue | undefined) => {
  const a = asList(v);
  return a.length >= 3 && a.slice(0, 3).every((n) => typeof n === "number") ? { x: a[0] as number, y: a[1] as number, z: a[2] as number } : null;
};

export function readPlayerState(nbt: NbtCompound): PlayerState {
  const all = itemsOf(nbt.Inventory);
  const eq = isCompound(nbt.equipment) ? nbt.equipment : null;
  const slotItem = (slot: number) => all.find((i) => i.slot === slot) ?? null;
  // Boots, leggings, chestplate, helmet: slots 100–103 until 1.21.4, an `equipment` compound after.
  const armor = eq ? ["feet", "legs", "chest", "head"].map((k, i) => parseItem(eq[k], 100 + i)) : [100, 101, 102, 103].map(slotItem);
  const offhand = eq ? parseItem(eq.offhand, -106) : slotItem(-106);

  const respawn = isCompound(nbt.respawn) ? nbt.respawn : null;
  const spawnPos = respawn ? triple(respawn.pos) : asNumber(nbt.SpawnX) !== null ? { x: nbt.SpawnX as number, y: asNumber(nbt.SpawnY) ?? 0, z: asNumber(nbt.SpawnZ) ?? 0 } : null;
  const death = isCompound(nbt.LastDeathLocation) ? nbt.LastDeathLocation : null;
  const lastDeathPos = death ? triple(death.pos) : null;
  const mode = asNumber(nbt.playerGameType);

  return {
    health: asNumber(nbt.Health),
    food: asNumber(nbt.foodLevel),
    saturation: asNumber(nbt.foodSaturationLevel),
    xpLevel: asNumber(nbt.XpLevel),
    xpProgress: asNumber(nbt.XpP),
    gameMode: mode !== null ? (GAME_MODES[mode] ?? null) : null,
    dimension: dimensionOf(nbt.Dimension),
    pos: triple(nbt.Pos),
    spawn: spawnPos ? { ...spawnPos, dimension: dimensionOf(respawn?.dimension ?? nbt.SpawnDimension) } : null,
    lastDeath: lastDeathPos && death ? { ...lastDeathPos, dimension: dimensionOf(death.dimension) } : null,
    selectedSlot: asNumber(nbt.SelectedItemSlot),
    inventory: all.filter((i) => i.slot >= 0 && i.slot <= 35).sort((a, b) => a.slot - b.slot),
    armor,
    offhand,
    enderChest: itemsOf(nbt.EnderItems).sort((a, b) => a.slot - b.slot),
  };
}
