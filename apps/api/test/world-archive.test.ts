import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createZip } from "@craftpanel/backup";
import { planWorldImport, readZipEntryNames, suggestWorldName, uniqueWorldName } from "@craftpanel/shared";

const plan = (...names: string[]) => planWorldImport(names);

describe("planWorldImport", () => {
  it("takes a world at the top of the archive", () => {
    const r = plan("level.dat", "region/r.0.0.mca", "DIM-1/region/r.0.0.mca");
    expect(r).toMatchObject({ ok: true, plan: { sourceName: "", folders: [{ source: "", suffix: "" }], dimensions: ["overworld", "nether"] } });
  });

  it("takes a world in one or two wrapper folders", () => {
    expect(plan("My World/level.dat", "My World/region/r.0.0.mca")).toMatchObject({ ok: true, plan: { sourceName: "My World", folders: [{ source: "My World", suffix: "" }] } });
    expect(plan("saves/My World/level.dat")).toMatchObject({ ok: true, plan: { folders: [{ source: "saves/My World" }] } });
    expect(plan("a/b/c/level.dat")).toMatchObject({ ok: false });
  });

  it("keeps Paper's Nether and End folders with their world", () => {
    const r = plan("world/level.dat", "world_nether/level.dat", "world_the_end/level.dat", "world_nether/DIM-1/region/r.0.0.mca", "plugins/x.jar");
    expect(r).toMatchObject({
      ok: true,
      plan: { sourceName: "world", folders: [{ source: "world", suffix: "" }, { source: "world_nether", suffix: "_nether" }, { source: "world_the_end", suffix: "_the_end" }], dimensions: ["overworld", "nether", "the_end"] },
    });
  });

  it("sees the dimensions of the 26.1 layout", () => {
    expect(plan("w/level.dat", "w/dimensions/minecraft/the_end/region/r.0.0.mca")).toMatchObject({ ok: true, plan: { dimensions: ["overworld", "the_end"] } });
  });

  it("ignores macOS resource forks and worlds nested inside a world", () => {
    expect(plan("__MACOSX/w/._level.dat", "w/level.dat", "w/backup/level.dat", "__MACOSX/level.dat")).toMatchObject({ ok: true, plan: { folders: [{ source: "w" }] } });
  });

  it("explains what is wrong with an archive", () => {
    expect(plan("readme.txt", "plugins/a.jar")).toMatchObject({ ok: false, message: expect.stringContaining("level.dat") });
    const several = plan("one/level.dat", "two/level.dat");
    expect(several).toMatchObject({ ok: false, message: expect.stringContaining("several worlds"), hint: expect.stringContaining("one world at a time") });
  });
});

describe("world names", () => {
  it("adds a number until the name is free", () => {
    expect(uniqueWorldName("World", ["Other"])).toBe("World");
    expect(uniqueWorldName("World", ["world", "World 2"])).toBe("World 3");
    expect(uniqueWorldName("  ", [])).toBe("World");
  });
  it("turns file names into valid world names", () => {
    expect(suggestWorldName("My Süper-World (1).zip")).toBe("My S_per-World _1_");
    expect(suggestWorldName("..zip.zip")).toBe("zip");
  });
});

describe("readZipEntryNames", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-zip-"));
    await fs.mkdir(path.join(dir, "src", "Welt ä", "region"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "Welt ä", "level.dat"), "x");
    await fs.writeFile(path.join(dir, "src", "Welt ä", "region", "r.0.0.mca"), "y");
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("lists the entries of a real archive without reading the rest", async () => {
    const file = path.join(dir, "w.zip");
    await createZip({ sourceDir: path.join(dir, "src"), destination: file });
    const buf = await fs.readFile(file);
    const names = await readZipEntryNames(new Blob([buf]));
    expect(names).toEqual(expect.arrayContaining(["Welt ä/level.dat", "Welt ä/region/r.0.0.mca"]));
    expect(planWorldImport(names!)).toMatchObject({ ok: true, plan: { sourceName: "Welt ä" } });
  });

  it("gives up quietly on anything that is not a zip", async () => {
    expect(await readZipEntryNames(new Blob(["definitely not a zip file, just text"]))).toBeNull();
    expect(await readZipEntryNames(new Blob([]))).toBeNull();
  });
});
