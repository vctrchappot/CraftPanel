import fsp from "node:fs/promises";
import path from "node:path";
import { fetchSkin, isMojangUuid } from "@craftpanel/minecraft-providers";

const HIT_TTL = 24 * 3_600_000;
/** An account without a skin (or an unknown one) is asked about again after this long. */
const MISS_TTL = 3_600_000;
/** After Mojang refused or couldn't be reached, leave it alone for this long and serve what is on disk. */
const BACKOFF = 10 * 60_000;

const inflight = new Map<string, Promise<Buffer | null>>();
const backoff = new Map<string, number>();

async function ageOf(file: string): Promise<number | null> {
  try {
    return Date.now() - (await fsp.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A player's skin PNG, kept on disk so the dashboard asks Mojang about each account at most once a day (the session
 * server limits profile requests per account). A stale copy is better than none when Mojang can't be reached.
 */
export function cachedSkin(cacheDir: string, uuid: string, fetcher: (uuid: string) => Promise<Buffer | null> = fetchSkin): Promise<Buffer | null> {
  if (!isMojangUuid(uuid)) return Promise.resolve(null);
  const id = uuid.toLowerCase();
  const png = path.join(cacheDir, "skins", `${id}.png`);
  const none = path.join(cacheDir, "skins", `${id}.none`);
  const pending = inflight.get(id);
  if (pending) return pending;
  const run = (async () => {
    const [hit, miss] = await Promise.all([ageOf(png), ageOf(none)]);
    if (hit !== null && hit < HIT_TTL) return fsp.readFile(png);
    if (miss !== null && miss < MISS_TTL) return null;
    const stale = async () => (hit !== null ? fsp.readFile(png) : null);
    if (Date.now() - (backoff.get(id) ?? 0) < BACKOFF) return stale();
    try {
      const skin = await fetcher(id);
      await fsp.mkdir(path.dirname(png), { recursive: true });
      if (skin) {
        await fsp.writeFile(png, skin);
        await fsp.rm(none, { force: true });
      } else {
        await fsp.writeFile(none, "");
        await fsp.rm(png, { force: true });
      }
      backoff.delete(id);
      return skin;
    } catch {
      backoff.set(id, Date.now());
      return stale();
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}
