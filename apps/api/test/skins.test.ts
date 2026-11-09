import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cachedSkin } from "../src/services/skins";

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-skin-"));
});
afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

const skin = Buffer.from("png-bytes");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("skin cache", () => {
  it("asks Mojang once and serves the file afterwards", async () => {
    const fetcher = vi.fn().mockResolvedValue(skin);
    expect(await cachedSkin(dir, uuid(1), fetcher)).toEqual(skin);
    expect(await cachedSkin(dir, uuid(1), fetcher)).toEqual(skin);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shares one lookup between simultaneous requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(skin);
    await Promise.all([cachedSkin(dir, uuid(2), fetcher), cachedSkin(dir, uuid(2), fetcher), cachedSkin(dir, uuid(2), fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("remembers that an account has no skin", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    expect(await cachedSkin(dir, uuid(3), fetcher)).toBeNull();
    expect(await cachedSkin(dir, uuid(3), fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a stale copy when Mojang can't be reached, and doesn't hammer it", async () => {
    await fsp.mkdir(path.join(dir, "skins"), { recursive: true });
    const file = path.join(dir, "skins", `${uuid(4)}.png`);
    await fsp.writeFile(file, skin);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await fsp.utimes(file, old, old);
    const fetcher = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    expect(await cachedSkin(dir, uuid(4), fetcher)).toEqual(skin);
    expect(await cachedSkin(dir, uuid(4), fetcher)).toEqual(skin);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for an unreachable Mojang without a copy, and never for offline-mode UUIDs", async () => {
    expect(await cachedSkin(dir, uuid(5), vi.fn().mockRejectedValue(new Error("offline")))).toBeNull();
    const fetcher = vi.fn();
    expect(await cachedSkin(dir, "dd86bbc4-3c76-361f-8118-9cbe503cc245", fetcher)).toBeNull();
    expect(await cachedSkin(dir, "../../x", fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
