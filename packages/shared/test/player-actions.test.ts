import { describe, expect, it } from "vitest";
import { PLAYER_ACTIONS, planPlayerAction } from "../src/player-actions";

const plan = (id: string, params: unknown = {}) => planPlayerAction(id, "Steve", params);

describe("player action catalog", () => {
  it("has unique ids, and every action builds commands from its defaults", () => {
    expect(new Set(PLAYER_ACTIONS.map((a) => a.id)).size).toBe(PLAYER_ACTIONS.length);
    for (const a of PLAYER_ACTIONS) {
      // Text parameters without a default have to be filled in; give them something harmless.
      const filled = Object.fromEntries(a.params.filter((p) => p.kind === "text" || p.kind === "player").map((p) => [p.key, p.kind === "player" ? "Alex" : p.key === "item" ? "diamond" : "hello"]));
      const { commands } = plan(a.id, filled);
      expect(commands.length).toBeGreaterThan(0);
      for (const c of commands) expect(c).not.toMatch(/[\r\n]/);
    }
  });

  it("builds the console commands", () => {
    expect(plan("heal").commands).toEqual(["effect give Steve minecraft:instant_health 1 10 true", "effect give Steve minecraft:saturation 1 20 true"]);
    expect(plan("teleport-player", { target: "Alex" }).commands).toEqual(["tp Steve Alex"]);
    expect(plan("teleport-coords", { x: 10, y: 64, z: -5.5, dimension: "current" }).commands).toEqual(["tp Steve 10 64 -5.5"]);
    expect(plan("teleport-coords", { x: 0, y: 70, z: 0, dimension: "minecraft:the_nether" }).commands).toEqual(["execute in minecraft:the_nether run tp Steve 0 70 0"]);
    expect(plan("gamemode", { mode: "creative" }).commands).toEqual(["gamemode creative Steve"]);
    expect(plan("give-item", { item: "diamond", count: 3 }).commands).toEqual(["give Steve minecraft:diamond 3"]);
    expect(plan("effect", { effect: "levitation", seconds: 5, level: 2 }).commands).toEqual(["effect give Steve minecraft:levitation 5 1"]);
    expect(plan("sound", { sound: "entity.creeper.primed", pitch: 0.8 }).commands).toEqual(["execute at Steve run playsound minecraft:entity.creeper.primed master Steve ~ ~ ~ 1 0.8"]);
    expect(plan("kill").commands).toEqual(["kill Steve"]);
  });

  it("queues the subtitle before the title and leaves it out when empty", () => {
    expect(plan("title", { title: "Hi", subtitle: "there", seconds: 3 }).commands).toEqual(["title Steve times 10 60 20", 'title Steve subtitle {"text":"there"}', 'title Steve title {"text":"Hi"}']);
    expect(plan("title", { title: "Hi" }).commands).toEqual(["title Steve times 10 80 20", 'title Steve title {"text":"Hi"}']);
  });

  it("escapes free text so it stays one JSON string", () => {
    expect(plan("message", { text: 'say "hi" \\ <3' }).commands[0]).toBe('tellraw Steve {"text":"say \\"hi\\" \\\\ <3"}');
  });

  it("refuses values that could split or change a command", () => {
    expect(() => plan("message", { text: "a\nop Steve" })).toThrow(/single line/);
    expect(() => plan("title", { title: `x${String.fromCharCode(0x2028)}y` })).toThrow(/single line/);
    expect(() => plan("give-item", { item: "diamond 64\nop Steve" })).toThrow();
    expect(() => plan("give-item", { item: "diamond; stop" })).toThrow(/item id/);
    expect(() => plan("effect", { effect: "speed 99999 255 run stop" })).toThrow();
    expect(() => plan("sound", { sound: "x y z" })).toThrow();
    expect(() => plan("gamemode", { mode: "creative Steve\nop" })).toThrow();
    expect(() => plan("teleport-player", { target: "Alex run stop" })).toThrow(/username/);
    expect(() => plan("teleport-coords", { x: "1 2 3", y: 1, z: 1, dimension: "current" })).toThrow();
    expect(() => plan("teleport-coords", { x: 1, y: 1, z: 1, dimension: "minecraft:overworld run stop" })).toThrow();
  });

  it("holds numbers to their range and to whole numbers where needed", () => {
    expect(() => plan("effect", { effect: "speed", seconds: 0, level: 1 })).toThrow(/between/);
    expect(() => plan("effect", { effect: "speed", seconds: 5, level: 11 })).toThrow(/between/);
    expect(() => plan("effect", { effect: "speed", seconds: 5.5, level: 1 })).toThrow(/whole number/);
    expect(() => plan("set-xp", { level: -1 })).toThrow(/between/);
    expect(() => plan("teleport-coords", { x: Infinity, y: 1, z: 1, dimension: "current" })).toThrow();
    expect(() => plan("message", {})).toThrow(/required/);
  });

  it("does not accept a typed id where the form has a fixed list", () => {
    expect(() => plan("gamemode", { mode: "hardcore" })).toThrow();
    expect(plan("effect", { effect: "mymod:fear", seconds: 5, level: 1 }).commands[0]).toBe("effect give Steve mymod:fear 5 0");
    expect(() => plan("nope")).toThrow(/Unknown player action/);
  });

  it("marks what hurts or deletes as harsh", () => {
    const harsh = PLAYER_ACTIONS.filter((a) => a.severity === "harsh").map((a) => a.id);
    expect(harsh).toEqual(expect.arrayContaining(["kill", "clear-inventory", "lightning", "launch"]));
    expect(harsh).not.toContain("title");
  });
});
