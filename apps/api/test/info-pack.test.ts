import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INFO_PACK_DIR, syncInfoPack } from "../src/services/info-pack";

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-infopack-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const pack = (world = "world") => path.join(dir, world, "datapacks", INFO_PACK_DIR);
const exists = (p: string) => fsp.access(p).then(() => true, () => false);

describe("info datapack", () => {
  it("installs into the active world with both function folder layouts", async () => {
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=survival\n");
    expect(await syncInfoPack(dir, true)).toBe(true);
    const p = pack("survival");
    const mcmeta = JSON.parse(await fsp.readFile(path.join(p, "pack.mcmeta"), "utf8"));
    expect(mcmeta.pack.min_format).toBeLessThanOrEqual(mcmeta.pack.pack_format);
    for (const d of ["function", "functions"]) {
      expect(await exists(path.join(p, "data", "craftpanel", d, "info.mcfunction"))).toBe(true);
      expect(JSON.parse(await fsp.readFile(path.join(p, "data", "minecraft", "tags", d, "load.json"), "utf8")).values).toEqual(["craftpanel:load"]);
    }
    const info = await fsp.readFile(path.join(p, "data", "craftpanel", "function", "info.mcfunction"), "utf8");
    // Every tellraw argument must be valid JSON on a single line.
    for (const line of info.split("\n").filter((l) => l.startsWith("tellraw @s "))) expect(() => JSON.parse(line.slice("tellraw @s ".length))).not.toThrow();
    expect(info).toContain("scoreboard players set @s craftpanel 0");
  });

  it("is idempotent and removes only its own pack when disabled", async () => {
    await syncInfoPack(dir, true);
    expect(await syncInfoPack(dir, true)).toBe(false);
    expect(await syncInfoPack(dir, false)).toBe(true);
    expect(await exists(pack())).toBe(false);

    // A user's folder with the same name (no marker) is left alone.
    await fsp.mkdir(pack(), { recursive: true });
    await fsp.writeFile(path.join(pack(), "pack.mcmeta"), "{}");
    expect(await syncInfoPack(dir, false)).toBe(false);
    expect(await exists(path.join(pack(), "pack.mcmeta"))).toBe(true);
  });

  it("never writes outside the server directory", async () => {
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=../escaped\n");
    expect(await syncInfoPack(dir, true)).toBe(false);
    expect(await exists(path.join(dir, "..", "escaped"))).toBe(false);
  });
});
