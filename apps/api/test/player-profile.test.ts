import { describe, expect, it } from "vitest";
import type { NbtCompound } from "@craftpanel/config";
import { normalizeAdvancements, normalizeStats, parseAdvancementTime, parseItem, readPlayerInspect, readPlayerState, summarizeActivity } from "../src/services/player-profile";

const H = 3_600_000;
const D = 24 * H;

describe("summarizeActivity", () => {
  // 2024-05-06 is a Monday.
  const monday10 = Date.UTC(2024, 4, 6, 10, 0, 0);

  it("totals playtime, averages finished sessions and ignores open ones for the average", () => {
    const now = monday10 + 5 * D;
    const a = summarizeActivity(
      [
        { id: 1, joinedAt: monday10, leftAt: monday10 + 2 * H, ip: "10.0.0.2" },
        { id: 2, joinedAt: monday10 + D, leftAt: monday10 + D + 4 * H, ip: "10.0.0.2" },
        { id: 3, joinedAt: now - H, leftAt: null, ip: "10.0.0.9" },
      ],
      now,
    );
    expect(a.sessions).toBe(3);
    expect(a.playtimeMs).toBe(7 * H);
    expect(a.averageMs).toBe(3 * H);
    expect(a.longestMs).toBe(4 * H);
    expect(a.addresses.map((x) => [x.ip, x.sessions])).toEqual([["10.0.0.9", 1], ["10.0.0.2", 2]]);
    expect(a.recent[0].id).toBe(3);
  });

  it("spreads a session over the hours it covers and finds the peak", () => {
    const a = summarizeActivity([{ id: 1, joinedAt: monday10 + 30 * 60_000, leftAt: monday10 + 2 * H + 15 * 60_000, ip: null }], monday10 + D);
    expect(a.heat[0][10]).toBe(30 * 60_000);
    expect(a.heat[0][11]).toBe(H);
    expect(a.heat[0][12]).toBe(15 * 60_000);
    expect(a.peak).toEqual({ weekday: 0, hour: 11 });
  });

  it("buckets by the viewer's clock", () => {
    // UTC+2 (getTimezoneOffset() = -120): 10:00 UTC is 12:00 local.
    const a = summarizeActivity([{ id: 1, joinedAt: monday10, leftAt: monday10 + H, ip: null }], monday10 + H, -120);
    expect(a.heat[0][12]).toBe(H);
    expect(a.heat[0][10]).toBe(0);
  });

  it("returns 30 days ending today and splits a session across midnight", () => {
    const start = Date.UTC(2024, 4, 6, 23, 0, 0);
    const a = summarizeActivity([{ id: 1, joinedAt: start, leftAt: start + 2 * H, ip: null }], start + 3 * H);
    expect(a.daily).toHaveLength(30);
    expect(a.daily[29]).toEqual({ day: "2024-05-07", ms: H });
    expect(a.daily[28]).toEqual({ day: "2024-05-06", ms: H });
    expect(a.daily[0].day).toBe("2024-04-08");
  });

  it("caps a session that was never closed", () => {
    const a = summarizeActivity([{ id: 1, joinedAt: monday10, leftAt: null, ip: null }], monday10 + 90 * D);
    expect(a.playtimeMs).toBe(14 * D);
  });

  it("is empty for a player without sessions", () => {
    const a = summarizeActivity([], monday10);
    expect(a).toMatchObject({ sessions: 0, playtimeMs: 0, averageMs: 0, peak: null, recent: [] });
  });
});

describe("normalizeStats", () => {
  const raw = {
    DataVersion: 4189,
    stats: {
      "minecraft:custom": {
        "minecraft:play_time": 72_000,
        "minecraft:deaths": 3,
        "minecraft:mob_kills": 41,
        "minecraft:damage_dealt": 1230,
        "minecraft:walk_one_cm": 500_000,
        "minecraft:sprint_one_cm": 120_000,
        "minecraft:fish_caught": 4,
        "minecraft:open_chest": 0,
      },
      "minecraft:mined": { "minecraft:stone": 900, "minecraft:dirt": 100, "minecraft:diamond_ore": 7 },
      "minecraft:killed": { "minecraft:zombie": 20, "minecraft:creeper": 21 },
    },
  };

  it("derives totals, rankings and distances", () => {
    const s = normalizeStats(raw)!;
    expect(s.playTicks).toBe(72_000);
    expect(s.deaths).toBe(3);
    expect(s.mobKills).toBe(41);
    expect(s.damageDealt).toBe(123);
    expect(s.totals.mined).toBe(1007);
    expect(s.mined[0]).toEqual({ id: "minecraft:stone", count: 900 });
    expect(s.killed[0].id).toBe("minecraft:creeper");
    expect(s.distances).toEqual([{ id: "walk", cm: 500_000 }, { id: "sprint", cm: 120_000 }]);
    expect(s.highlights).toEqual([{ id: "fish_caught", count: 4 }]);
  });

  it("reads the pre-1.17 play counter and rejects other layouts", () => {
    expect(normalizeStats({ stats: { "minecraft:custom": { "minecraft:play_one_minute": 5 } } })!.playTicks).toBe(5);
    expect(normalizeStats({ "stat.walkOneCm": 5 })).toBeNull();
    expect(normalizeStats(null)).toBeNull();
    expect(normalizeStats({ stats: {} })).toMatchObject({ playTicks: null, deaths: 0, mined: [] });
  });
});

describe("normalizeAdvancements", () => {
  it("counts done advancements per category, apart from recipes, newest first", () => {
    const a = normalizeAdvancements({
      DataVersion: 1,
      "minecraft:story/root": { done: true, criteria: { x: "2024-05-01 10:00:00 +0200" } },
      "minecraft:story/mine_stone": { done: true, criteria: { x: "2024-05-01 10:05:00 +0200" } },
      "minecraft:nether/root": { done: true, criteria: { x: "2024-05-02 10:00:00 +0200" } },
      "minecraft:adventure/kill_a_mob": { done: false, criteria: {} },
      "minecraft:recipes/misc/stick": { done: true, criteria: {} },
      "custom:thing/one": { done: true, criteria: {} },
    })!;
    expect(a.done).toBe(4);
    expect(a.recipes).toBe(1);
    expect(a.categories).toEqual([{ id: "story", done: 2 }, { id: "nether", done: 1 }, { id: "custom", done: 1 }]);
    expect(a.recent[0].id).toBe("minecraft:nether/root");
    expect(a.recent[0].at).toBe(Date.UTC(2024, 4, 2, 8, 0, 0));
  });

  it("parses Minecraft's timestamp format", () => {
    expect(parseAdvancementTime("2024-05-01 10:00:00 +0200")).toBe(Date.UTC(2024, 4, 1, 8));
    expect(parseAdvancementTime("2024-05-01 10:00:00 -0530")).toBe(Date.UTC(2024, 4, 1, 15, 30));
    expect(parseAdvancementTime("yesterday")).toBeNull();
  });
});

describe("items and player state", () => {
  it("reads 1.21.5+ items (count, enchantment levels, custom name compound)", () => {
    const item = parseItem({ id: "minecraft:diamond_sword", count: 1, components: { "minecraft:enchantments": { "minecraft:sharpness": 5 }, "minecraft:custom_name": '{"text":"Excalibur"}', "minecraft:damage": 12 } }, 3);
    expect(item).toEqual({ slot: 3, id: "minecraft:diamond_sword", count: 1, name: "Excalibur", enchantments: [{ id: "minecraft:sharpness", level: 5 }], damage: 12 });
  });

  it("reads 1.20.5–1.21.4 items (levels wrapper) and legacy tags", () => {
    expect(parseItem({ id: "minecraft:bow", count: 1, components: { "minecraft:enchantments": { levels: { "minecraft:power": 3 }, show_in_tooltip: 1 } } }, 0)!.enchantments).toEqual([{ id: "minecraft:power", level: 3 }]);
    const legacy = parseItem({ id: "minecraft:stick", Count: 64, tag: { display: { Name: '{"text":"Staff"}' }, Enchantments: [{ id: "minecraft:knockback", lvl: 2 }], Damage: 4 } }, 1)!;
    expect(legacy).toMatchObject({ count: 64, name: "Staff", enchantments: [{ id: "minecraft:knockback", level: 2 }], damage: 4 });
  });

  it("skips air and empty stacks", () => {
    expect(parseItem({ id: "minecraft:air", count: 1 }, 0)).toBeNull();
    expect(parseItem({ id: "minecraft:dirt", count: 0 }, 0)).toBeNull();
    expect(parseItem("x", 0)).toBeNull();
  });

  const player = (extra: NbtCompound): NbtCompound => ({
    Health: 17.5,
    foodLevel: 18,
    foodSaturationLevel: 2.5,
    XpLevel: 12,
    XpP: 0.4,
    playerGameType: 1,
    Dimension: "minecraft:the_nether",
    Pos: [10.5, 70, -3.25],
    SelectedItemSlot: 2,
    Inventory: [
      { Slot: 0, id: "minecraft:stone", count: 64 },
      { Slot: 35, id: "minecraft:apple", count: 3 },
    ],
    EnderItems: [{ Slot: 4, id: "minecraft:diamond", count: 9 }],
    ...extra,
  });

  it("reads vitals, position and inventory with armor in slots 100–103 and the offhand in -106", () => {
    const s = readPlayerState(
      player({
        Inventory: [
          { Slot: 0, id: "minecraft:stone", count: 64 },
          { Slot: 100, id: "minecraft:iron_boots", count: 1 },
          { Slot: 103, id: "minecraft:iron_helmet", count: 1 },
          { Slot: -106, id: "minecraft:shield", count: 1 },
        ],
        SpawnX: 1,
        SpawnY: 2,
        SpawnZ: 3,
        SpawnDimension: "minecraft:overworld",
        LastDeathLocation: { dimension: "minecraft:overworld", pos: [5, 6, 7] },
      }),
    );
    expect(s).toMatchObject({ health: 17.5, food: 18, xpLevel: 12, gameMode: "creative", dimension: "minecraft:the_nether", pos: { x: 10.5, y: 70, z: -3.25 }, selectedSlot: 2 });
    expect(s.inventory.map((i) => i.id)).toEqual(["minecraft:stone"]);
    expect(s.armor.map((i) => i?.id ?? null)).toEqual(["minecraft:iron_boots", null, null, "minecraft:iron_helmet"]);
    expect(s.offhand?.id).toBe("minecraft:shield");
    expect(s.spawn).toEqual({ x: 1, y: 2, z: 3, dimension: "minecraft:overworld" });
    expect(s.lastDeath).toEqual({ x: 5, y: 6, z: 7, dimension: "minecraft:overworld" });
    expect(s.enderChest).toEqual([{ slot: 4, id: "minecraft:diamond", count: 9 }]);
  });

  it("reads the newer equipment compound and respawn data, and legacy numeric dimensions", () => {
    const s = readPlayerState(player({ Dimension: -1, equipment: { head: { id: "minecraft:diamond_helmet", count: 1 }, offhand: { id: "minecraft:totem_of_undying", count: 1 } }, respawn: { pos: [9, 8, 7], dimension: "minecraft:overworld" } }));
    expect(s.dimension).toBe("minecraft:the_nether");
    expect(s.armor.map((i) => i?.id ?? null)).toEqual([null, null, null, "minecraft:diamond_helmet"]);
    expect(s.offhand?.id).toBe("minecraft:totem_of_undying");
    expect(s.spawn).toEqual({ x: 9, y: 8, z: 7, dimension: "minecraft:overworld" });
  });

  it("tolerates an almost empty file", () => {
    const s = readPlayerState({});
    expect(s).toMatchObject({ health: null, gameMode: null, dimension: null, pos: null, spawn: null, inventory: [], armor: [null, null, null, null], offhand: null, enderChest: [] });
  });
});

describe("readPlayerInspect", () => {
  it("reads flags, tags, effects and values, from the namespaced and the numeric effect layouts", () => {
    const i = readPlayerInspect(
      {
        abilities: { flying: 1, mayfly: 1, invulnerable: 0, instabuild: 1, mayBuild: 0, walkSpeed: 0.1, flySpeed: 0.05 },
        Fire: 40,
        FallFlying: 1,
        Tags: ["builder", "vip", 5],
        active_effects: [{ id: "minecraft:speed", amplifier: 1, duration: 200 }, { id: "minecraft:night_vision", amplifier: 0, duration: -1 }],
        XpTotal: 1395,
        Air: 300,
        Rotation: [90, 12.4],
        Inventory: [{ id: "minecraft:stone", count: 1, Slot: 0 }],
      },
      "game",
      null,
    );
    const on = i.flags.filter((f) => f.on).map((f) => f.id);
    expect(on).toEqual(["flying", "mayfly", "instabuild", "onFire", "gliding"]);
    expect(i.flags.find((f) => f.id === "mayBuild")?.on).toBe(false);
    expect(i.tags).toEqual(["builder", "vip"]);
    expect(i.effects).toEqual([{ id: "minecraft:speed", level: 2, seconds: 10 }, { id: "minecraft:night_vision", level: 1, seconds: null }]);
    expect(i.values).toEqual(expect.arrayContaining([{ label: "Fire", value: "2.0 s" }, { label: "Total experience", value: "1395" }, { label: "Air", value: "300 / 300" }, { label: "Rotation", value: "90° / 12°" }]));
    expect(i.source).toBe("game");

    const old = readPlayerInspect({ ActiveEffects: [{ Id: 1, Amplifier: 0, Duration: 100 }] }, "file", 5);
    expect(old.effects).toEqual([{ id: "effect 1", level: 1, seconds: 5 }]);
    expect(old.savedAt).toBe(5);
  });

  it("groups plugin data by namespace and keeps the inventory out of the raw view", () => {
    const i = readPlayerInspect(
      {
        BukkitValues: { "luckperms:meta": "a", "luckperms:rank": 3, "essentials:afk": 1, nonamespace: "x", "long:value": "y".repeat(400) },
        Inventory: [{ id: "minecraft:stone", count: 1, Slot: 0 }],
        EnderItems: [],
        recipeBook: { recipes: [] },
        Health: 20,
      },
      "file",
      null,
    );
    expect(i.plugins.map((g) => [g.namespace, g.entries.length])).toEqual([["essentials", 1], ["long", 1], ["luckperms", 2], ["other", 1]]);
    expect(i.plugins[1].entries[0].value.length).toBeLessThan(200);
    const raw = JSON.parse(i.raw) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["BukkitValues", "Health"]);
  });

  it("is happy with an almost empty file", () => {
    const i = readPlayerInspect({}, "file", null);
    expect(i.flags.filter((f) => f.on)).toEqual([{ id: "mayBuild", label: "May build", on: true }]);
    expect(i).toMatchObject({ tags: [], effects: [], plugins: [], values: [] });
  });
});
