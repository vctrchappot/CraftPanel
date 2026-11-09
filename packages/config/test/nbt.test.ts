import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseNbt, parseNbtFile } from "../src/nbt";

/** Tiny NBT writer for fixtures: [type, name, payload bytes]. */
const str = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const f64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};
const tag = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), str(name), payload]);
const compound = (name: string, ...children: Buffer[]) => tag(10, name, Buffer.concat([...children, Buffer.from([0])]));

const sample = compound(
  "",
  tag(1, "Slot", Buffer.from([0xf6])), // -10
  tag(3, "XpLevel", i32(30)),
  tag(8, "id", str("minecraft:diamond_sword")),
  tag(9, "Pos", Buffer.concat([Buffer.from([6]), i32(3), f64(1.5), f64(64), f64(-20.25)])),
  tag(11, "pos", Buffer.concat([i32(2), i32(7), i32(-8)])),
  compound("nested", tag(2, "s", Buffer.from([0x01, 0x00]))),
);

describe("parseNbt", () => {
  it("reads numbers, strings, lists, arrays and nested compounds", () => {
    expect(parseNbt(sample)).toEqual({ Slot: -10, XpLevel: 30, id: "minecraft:diamond_sword", Pos: [1.5, 64, -20.25], pos: [7, -8], nested: { s: 256 } });
  });

  it("reads gzipped files and rejects other data", () => {
    expect(parseNbtFile(zlib.gzipSync(sample)).XpLevel).toBe(30);
    expect(parseNbtFile(sample).XpLevel).toBe(30);
    expect(() => parseNbt(Buffer.from([1, 0, 0, 5]))).toThrow(/not a compound/);
  });

  it("fails cleanly on truncated or hostile data instead of allocating", () => {
    expect(() => parseNbt(sample.subarray(0, sample.length - 6))).toThrow();
    // An int array claiming a billion entries.
    expect(() => parseNbt(compound("", tag(11, "a", i32(1_000_000_000))))).toThrow(/out of range/);
    // A list nested far deeper than any real file.
    const nested = (depth: number): Buffer => (depth === 0 ? Buffer.concat([Buffer.from([1]), i32(0)]) : Buffer.concat([Buffer.from([9]), i32(1), nested(depth - 1)]));
    expect(() => parseNbt(compound("", tag(9, "d", nested(100))))).toThrow(/too deeply/);
  });
});
