import { describe, expect, it } from "vitest";
import { timeAgo, formatDateTime, formatDistance, formatPlaytime } from "../src/lib/format";
import { eventStyle } from "../src/lib/activity";
import { connectEntries } from "../src/lib/network";
import { playerInsights, travelDistances } from "../src/lib/player-insights";

describe("dashboard presentation", () => {
  it("formats relative times in the English UI locale regardless of the host locale", () => {
    const now = Date.UTC(2026, 10, 9, 12);
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(timeAgo(now - 86400_000, now)).toBe("yesterday");
    expect(timeAgo(now + 2 * 3600_000, now)).toBe("in 2 hours");
    expect(timeAgo(null, now)).toBe("never");
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(formatDateTime(now)).toContain("Nov");
  });

  it("uses lifecycle colours and distinct icons while keeping updates neutral", () => {
    expect(eventStyle({ kind: "server.running", level: "info" })).toEqual({ tone: "running", icon: "online" });
    expect(eventStyle({ kind: "server.start", level: "info" }).tone).toBe("starting");
    expect(eventStyle({ kind: "server.stopped", level: "info" }).tone).toBe("stopped");
    expect(eventStyle({ kind: "server.crashed", level: "error" }).tone).toBe("crashed");
    expect(eventStyle({ kind: "server.installed", level: "info" })).toEqual({ tone: "neutral", icon: "install" });
    expect(eventStyle({ kind: "craftpanel.updated", level: "info" })).toEqual({ tone: "neutral", icon: "update" });
    expect(eventStyle({ kind: "backup.failed", level: "error" }).tone).toBe("crashed");
    expect(eventStyle({ kind: "other", level: "warn" }).tone).toBe("warning");
  });

  it("keeps adapter labels from new APIs and supports the previous address response", () => {
    const network = [{ address: "172.20.0.1", kind: "virtual" as const, label: "Virtual adapter (WSL)" }];
    expect(connectEntries({ local: "localhost", lan: ["172.20.0.1"], network })).toEqual(network);
    expect(connectEntries({ local: "localhost", lan: ["192.168.1.4"] })).toEqual([
      { address: "192.168.1.4", kind: "lan", label: "Local network" },
    ]);
  });
});

describe("player presentation", () => {
  it("formats distances and playtime in the unit that reads best", () => {
    expect(formatDistance(85_000)).toBe("850 m");
    expect(formatDistance(1_240_000)).toBe("12.4 km");
    expect(formatDistance(null)).toBe("—");
    expect(formatPlaytime(25 * 60_000)).toBe("25 min");
    expect(formatPlaytime(3.5 * 3_600_000)).toBe("3 h 30 min");
    expect(formatPlaytime(30 * 3_600_000)).toBe("30 h");
    expect(formatPlaytime(100 * 3_600_000)).toBe("4 d 4 h");
  });

  it("derives short observations from a profile and says nothing without data", () => {
    const base = {
      name: "Alex",
      uuid: null,
      online: false,
      onlineSince: null,
      whitelisted: false,
      opLevel: null,
      ban: null,
      firstSeen: 0,
      lastSeen: Date.UTC(2026, 9, 1),
      activity: { sessions: 5, playtimeMs: 0, averageMs: 3_600_000, longestMs: 5 * 3_600_000, peak: { weekday: 0, hour: 20 }, daily: [], heat: [], recent: [], addresses: [] },
      stats: null,
      advancements: null,
      state: null,
      stateSource: null,
      events: [],
      world: "world",
      savedAt: null,
    };
    const now = Date.UTC(2026, 10, 9);
    const texts = playerInsights(base, now).map((i) => i.text);
    expect(texts).toContain("Hasn't played for 39 days.");
    expect(texts).toContain("Most active on Mondays around 20:00, in the evening.");
    expect(texts).toContain("Longest session: 5 h 0 min, against an average of 1 h 0 min.");
    expect(playerInsights({ ...base, lastSeen: now, activity: { ...base.activity, sessions: 1, peak: null } }, now)).toEqual([]);

    const stats = {
      playTicks: 72_000 * 12,
      sinceDeathTicks: null,
      deaths: 7,
      mobKills: 0,
      playerKills: 0,
      damageDealt: 0,
      damageTaken: 0,
      jumps: 0,
      distances: [{ id: "walk", cm: 700_000 }, { id: "boat", cm: 300_000 }, { id: "fall", cm: 900_000 }],
      totals: { mined: 1000, crafted: 0, used: 0, broken: 0, pickedUp: 0, dropped: 0, killed: 0, killedBy: 4 },
      mined: [{ id: "minecraft:stone", count: 900 }],
      crafted: [],
      used: [],
      broken: [],
      killed: [],
      killedBy: [{ id: "minecraft:creeper", count: 4 }],
      highlights: [],
    };
    const withStats = playerInsights({ ...base, lastSeen: now, stats, ban: { reason: "Griefing", created: null, source: "Admin" } }, now).map((i) => i.text);
    expect(withStats).toContain("Banned: Griefing (by Admin).");
    expect(withStats).toContain("Mines mostly Stone: 90% of 1,000 blocks.");
    expect(withStats).toContain("Has died 7 times, most often to Creeper (4).");
    expect(withStats).toContain("Has travelled 10.0 km, 70% on foot, 30% by boat.");

    // A mob behind only some of the deaths isn't "most often"; other causes aren't in Minecraft's list.
    const few = playerInsights({ ...base, lastSeen: now, stats: { ...stats, killedBy: [{ id: "minecraft:creeper", count: 1 }] } }, now).map((i) => i.text);
    expect(few).toContain("Has died 7 times, 1 of them to Creeper.");
    expect(playerInsights({ ...base, lastSeen: now, stats: { ...stats, killedBy: [] } }, now).map((i) => i.text)).toContain("Has died 7 times.");
    // Fall damage and a few centimetres of water-walking are not travel.
    expect(travelDistances({ ...stats, distances: [{ id: "fall", cm: 900_000 }, { id: "walk_on_water", cm: 40 }, { id: "walk", cm: 500 }] })).toEqual([{ id: "walk", cm: 500 }]);
  });
});

describe("advancement names", () => {
  it("names a tab's root after the tab and others after their last segment", async () => {
    const { advancementName } = await import("../src/lib/player-insights");
    expect(advancementName("minecraft:husbandry/root")).toBe("Husbandry");
    expect(advancementName("minecraft:story/mine_stone")).toBe("Mine Stone");
    expect(advancementName("minecraft:nether/ride_strider_in_overworld_1000")).toBe("Ride Strider in Overworld 1000");
    expect(advancementName("custom:quests/root")).toBe("Custom");
  });
});
