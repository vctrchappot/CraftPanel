import { describe, expect, it } from "vitest";
import { parseSnbt } from "../src/snbt";

describe("parseSnbt", () => {
  it("reads what /data get entity prints for a player", () => {
    const text =
      '{DataVersion: 4189, Health: 17.5f, foodLevel: 20, XpP: 0.4f, Pos: [10.5d, 70.0d, -3.25d], Dimension: "minecraft:overworld", ' +
      'Inventory: [{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:enchantments": {"minecraft:sharpness": 3}, "minecraft:custom_name": \'{"text":"Excalibur"}\'}}, ' +
      '{Slot: -106b, id: "minecraft:shield", count: 1}], EnderItems: [], UUID: [I; -1, 2, 3, 4], abilities: {flying: 0b, mayfly: true}}';
    expect(parseSnbt(text)).toEqual({
      DataVersion: 4189,
      Health: 17.5,
      foodLevel: 20,
      XpP: 0.4,
      Pos: [10.5, 70, -3.25],
      Dimension: "minecraft:overworld",
      Inventory: [
        { Slot: 0, id: "minecraft:diamond_sword", count: 1, components: { "minecraft:enchantments": { "minecraft:sharpness": 3 }, "minecraft:custom_name": '{"text":"Excalibur"}' } },
        { Slot: -106, id: "minecraft:shield", count: 1 },
      ],
      EnderItems: [],
      UUID: [-1, 2, 3, 4],
      abilities: { flying: 0, mayfly: 1 },
    });
  });

  it("handles number suffixes, exponents, escapes, empty containers and unquoted words", () => {
    expect(parseSnbt("{a: 1b, b: 2s, c: 3L, d: 4.5f, e: 6d, f: -7, g: 1.0E3, h: .5, i: {}, j: [], k: [B; 1b, 2b], l: abc_d, m: \"q\\\"uote\\\\\"}")).toEqual({
      a: 1,
      b: 2,
      c: 3,
      d: 4.5,
      e: 6,
      f: -7,
      g: 1000,
      h: 0.5,
      i: {},
      j: [],
      k: [1, 2],
      l: "abc_d",
      m: 'q"uote\\',
    });
    expect(parseSnbt("5b")).toBe(5);
    expect(parseSnbt('"text"')).toBe("text");
  });

  it("rejects malformed and hostile input", () => {
    for (const bad of ["{a: }", "{a 1}", "[1 2]", '{a: "open}', "{a: 1} trailing", "", "{,}"]) expect(() => parseSnbt(bad)).toThrow();
    expect(() => parseSnbt("[".repeat(100) + "]".repeat(100))).toThrow(/too deeply/);
    expect(() => parseSnbt("x".repeat(5 * 1024 * 1024))).toThrow(/too large/);
  });
});
