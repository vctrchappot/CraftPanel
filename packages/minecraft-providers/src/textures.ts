import fsp from "node:fs/promises";
import path from "node:path";
import { extractZip } from "@craftpanel/backup";
import { download } from "./download";
import { getVersionDetail } from "./mojang";

/**
 * Item and block textures for the dashboard's inventory view. They are Mojang's artwork, so CraftPanel doesn't ship
 * them: like the server jar, the game client for the server's version is downloaded from Mojang onto the machine
 * that runs CraftPanel, only the item and block PNGs are kept, and the jar is deleted again.
 */
const MAX_CLIENT_BYTES = 400 * 1024 * 1024;
const TEXTURE = /^assets\/minecraft\/textures\/(item|block)\/[a-z0-9_]+\.png$/;
/** After a failed download, don't retry for this long (the machine may simply be offline). */
const RETRY_AFTER_MS = 5 * 60_000;

const inflight = new Map<string, Promise<string>>();
const failures = new Map<string, { at: number; error: Error }>();

/** The folder with `item/` and `block/` PNGs for a Minecraft version, downloading it on first use. */
export function ensureTextures(opts: { mcVersion: string; cacheDir: string }): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(opts.mcVersion)) return Promise.reject(new Error("Invalid Minecraft version"));
  const dir = path.join(opts.cacheDir, "textures", opts.mcVersion);
  const pending = inflight.get(dir);
  if (pending) return pending;
  const failed = failures.get(dir);
  if (failed && Date.now() - failed.at < RETRY_AFTER_MS) return Promise.reject(failed.error);
  const run = (async () => {
    try {
      await fsp.access(path.join(dir, ".ready"));
      return dir;
    } catch {
      /* not extracted yet */
    }
    const detail = await getVersionDetail(opts.mcVersion);
    if (!detail.client) throw new Error(`Minecraft ${opts.mcVersion} has no client download`);
    const jar = `${dir}.client.jar`;
    const partial = `${dir}.partial`;
    try {
      await download({ url: detail.client.url, destination: jar, checksum: { algorithm: "sha1", value: detail.client.sha1 }, maxBytes: MAX_CLIENT_BYTES });
      await fsp.rm(partial, { recursive: true, force: true });
      const { files } = await extractZip({ file: jar, destination: partial, stripPrefix: "assets/minecraft/textures", filter: (n) => TEXTURE.test(n), limits: { maxTotalBytes: 2 * 1024 ** 3 } });
      if (!files) throw new Error("The client jar contains no item textures");
      await fsp.writeFile(path.join(partial, ".ready"), String(Date.now()));
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rename(partial, dir);
      failures.delete(dir);
      return dir;
    } catch (err) {
      await fsp.rm(partial, { recursive: true, force: true });
      failures.set(dir, { at: Date.now(), error: err as Error });
      throw err;
    } finally {
      await fsp.rm(jar, { force: true });
    }
  })().finally(() => inflight.delete(dir));
  inflight.set(dir, run);
  return run;
}

/** Item ids whose texture isn't named after them: a block seen from one face, or one frame of a dial. */
const ALIASES: Record<string, string[]> = {
  grass_block: ["block/grass_block_top"],
  crafting_table: ["block/crafting_table_front"],
  furnace: ["block/furnace_front"],
  blast_furnace: ["block/blast_furnace_front"],
  smoker: ["block/smoker_front"],
  dispenser: ["block/dispenser_front"],
  dropper: ["block/dropper_front"],
  observer: ["block/observer_front"],
  piston: ["block/piston_side"],
  sticky_piston: ["block/piston_side"],
  tnt: ["block/tnt_side"],
  compass: ["item/compass_16"],
  recovery_compass: ["item/recovery_compass_16"],
  clock: ["item/clock_00"],
};

/** Texture names to try for an item id, most specific first. */
export function textureCandidates(name: string): string[] {
  return [...(ALIASES[name] ?? []), `item/${name}`, `block/${name}`, `block/${name}_front`, `block/${name}_side`, `block/${name}_top`, `block/${name}_bottom`, `block/${name}_0`, `block/${name}_stage0`];
}

/** The PNG for `minecraft:<name>`, or null (modded items, items drawn from a model rather than a texture). */
export async function findItemTexture(dir: string, name: string): Promise<string | null> {
  if (!/^[a-z0-9_]{1,64}$/.test(name)) return null;
  for (const rel of textureCandidates(name)) {
    const file = path.join(dir, `${rel}.png`);
    try {
      if ((await fsp.stat(file)).isFile()) return file;
    } catch {
      /* try the next one */
    }
  }
  return null;
}
