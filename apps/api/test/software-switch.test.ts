import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerSandbox } from "@craftpanel/server-runtime";
import { findSplitDimensions, isDowngrade, mergeSplitDimensions } from "../src/services/software-switch";
import { parsePregen } from "../src/services/pregen";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function server(files: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-switch-"));
  dirs.push(root);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  return { root, sb: new ServerSandbox(root) };
}

describe("Paper dimension folders", () => {
  it("moves world_nether/DIM-1 and world_the_end/DIM1 back into the world", async () => {
    const { root, sb } = server(["world/level.dat", "world/region/r.0.0.mca", "world_nether/level.dat", "world_nether/DIM-1/region/r.0.0.mca", "world_the_end/level.dat", "world_the_end/DIM1/region/r.0.0.mca", "lobby/level.dat"]);
    const moves = await mergeSplitDimensions(sb);
    expect(moves.map((m) => [m.from, m.to, m.conflict])).toEqual([
      ["world_nether/DIM-1", "world/DIM-1", false],
      ["world_the_end/DIM1", "world/DIM1", false],
    ]);
    expect(fs.existsSync(path.join(root, "world/DIM-1/region/r.0.0.mca"))).toBe(true);
    expect(fs.existsSync(path.join(root, "world/DIM1/region/r.0.0.mca"))).toBe(true);
    // The emptied Paper folders are gone, so Paper converts cleanly if the server switches back.
    expect(fs.existsSync(path.join(root, "world_nether"))).toBe(false);
    expect(fs.existsSync(path.join(root, "world_the_end"))).toBe(false);
  });

  it("leaves both copies alone when the world already has that dimension", async () => {
    const { root, sb } = server(["world/level.dat", "world/DIM-1/region/old.mca", "world_nether/DIM-1/region/r.0.0.mca"]);
    const moves = await mergeSplitDimensions(sb);
    expect(moves).toMatchObject([{ conflict: true }]);
    expect(fs.existsSync(path.join(root, "world_nether/DIM-1/region/r.0.0.mca"))).toBe(true);
    expect(fs.existsSync(path.join(root, "world/DIM-1/region/old.mca"))).toBe(true);
  });

  it("ignores folders that only look like Paper dimensions", async () => {
    const { sb } = server(["world/level.dat", "world_nether/notes.txt", "orphan_nether/DIM-1/region/r.mca", "world/dimensions/minecraft/the_nether/region/r.mca"]);
    expect(await findSplitDimensions(sb)).toEqual([]);
  });
});

describe("isDowngrade", () => {
  const order = ["26.3", "26.2", "26w14a", "1.21.11", "1.21.4", "1.8.9"];
  it("uses Mojang's release order", async () => {
    expect(await isDowngrade("1.21.11", "1.21.4", order)).toBe(true);
    expect(await isDowngrade("1.21.11", "26.3", order)).toBe(false);
    expect(await isDowngrade("26.3", "26w14a", order)).toBe(true);
    expect(await isDowngrade("26.3", "26.3", order)).toBe(false);
  });
  it("compares numerically when a version is unknown", async () => {
    expect(await isDowngrade("1.21.10", "1.21.9", [])).toBe(true);
    expect(await isDowngrade("1.21.9", "1.21.10", [])).toBe(false);
    expect(await isDowngrade("26.1", "1.21.11", [])).toBe(true);
  });
});

describe("parsePregen", () => {
  const l = (text: string, ts = 1) => ({ text, ts });
  it("reads Chunky's progress, completion and pauses from the console", () => {
    expect(parsePregen([l("[12:00:01 INFO]: Done (3.2s)!"), l("[12:00:05 INFO]: [Chunky] Task running for world. Processed: 1234 chunks (5.67%), ETA: 0:12:34, Rate: 123.4 cps, Current: 12, -3", 5)])).toEqual({
      state: "running",
      world: "world",
      chunks: 1234,
      percent: 5.67,
      eta: "0:12:34",
      rate: 123.4,
      at: 5,
    });
    expect(parsePregen([l("[Server thread/INFO]: [Chunky] Task finished for minecraft:overworld. Processed: 4225 chunks (100.00%), Total time: 0:00:42")])).toMatchObject({ state: "finished", world: "minecraft:overworld", chunks: 4225, percent: 100, eta: null });
    // Real Chunky 1.4 output on Paper 1.21.11 for pause, continue and cancel.
    const run = l("[17:58:28 INFO]: [Chunky] Task running for world. Processed: 10 chunks (1.00%), ETA: 0:01:00, Rate: 5.0 cps, Current: 0, 0");
    const paused = [run, l("[17:58:29 INFO]: [Chunky] Task paused for world."), l("[17:58:29 INFO]: [Chunky] Task stopped for world.")];
    expect(parsePregen(paused)).toMatchObject({ state: "paused", chunks: 10, percent: 1 });
    expect(parsePregen([...paused, l("> chunky continue"), l("[17:58:33 INFO]: [Chunky] Task continuing for world.")])).toMatchObject({ state: "running", chunks: 10 });
    expect(parsePregen([run, l("[Chunky] Cancelling all tasks."), l("[17:58:37 INFO]: [Chunky] Task stopped for world.")])).toMatchObject({ state: "stopped" });
    expect(parsePregen([l("[17:58:23 INFO]: [Chunky] Task started in world for the square region centered at -16, -16 with radius 3000.")])).toMatchObject({ state: "running", world: "world", chunks: 0 });
    expect(parsePregen([l("nothing here")])).toBeNull();
  });
});
