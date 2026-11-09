import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createZip, extractZip } from "@craftpanel/backup";
import { findItemTexture, isMojangUuid, isSkinPng, skinUrlFromProfile, textureCandidates } from "../src";

let root: string;
beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-tex-"));
});
afterAll(() => fsp.rm(root, { recursive: true, force: true }));

describe("item textures", () => {
  it("tries the item texture first, then the block seen from its front, side or top", async () => {
    expect(textureCandidates("diamond_sword").slice(0, 2)).toEqual(["item/diamond_sword", "block/diamond_sword"]);
    expect(textureCandidates("crafting_table")[0]).toBe("block/crafting_table_front");
    expect(textureCandidates("compass")[0]).toBe("item/compass_16");
    const dir = path.join(root, "t");
    for (const f of ["item/apple.png", "block/sand.png", "block/furnace_front.png", "block/hay_block_side.png"]) {
      await fsp.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await fsp.writeFile(path.join(dir, f), "png");
    }
    expect(await findItemTexture(dir, "apple")).toBe(path.join(dir, "item", "apple.png"));
    expect(await findItemTexture(dir, "sand")).toBe(path.join(dir, "block", "sand.png"));
    expect(await findItemTexture(dir, "furnace")).toBe(path.join(dir, "block", "furnace_front.png"));
    expect(await findItemTexture(dir, "hay_block")).toBe(path.join(dir, "block", "hay_block_side.png"));
    expect(await findItemTexture(dir, "nothing_here")).toBeNull();
  });

  it("refuses names that aren't plain item ids", async () => {
    for (const bad of ["../x", "a/b", "A", "", "x".repeat(65), "a.png"]) expect(await findItemTexture(root, bad)).toBeNull();
  });

  it("extracts only item and block PNGs from a client archive", async () => {
    const src = path.join(root, "client-src");
    const files = ["assets/minecraft/textures/item/apple.png", "assets/minecraft/textures/block/sand.png", "assets/minecraft/textures/entity/zombie.png", "assets/minecraft/textures/item/readme.txt", "assets/minecraft/lang/en_us.json", "net/minecraft/Main.class"];
    for (const f of files) {
      await fsp.mkdir(path.dirname(path.join(src, f)), { recursive: true });
      await fsp.writeFile(path.join(src, f), "x");
    }
    const jar = path.join(root, "client.jar");
    await createZip({ sourceDir: src, destination: jar });
    const out = path.join(root, "client-out");
    const { files: n } = await extractZip({ file: jar, destination: out, stripPrefix: "assets/minecraft/textures", filter: (name) => /^assets\/minecraft\/textures\/(item|block)\/[a-z0-9_]+\.png$/.test(name) });
    expect(n).toBe(2);
    expect((await fsp.readdir(path.join(out, "item"))).sort()).toEqual(["apple.png"]);
    expect((await fsp.readdir(out)).sort()).toEqual(["block", "item"]);
  });
});

/** The 33 bytes up to IHDR's dimensions is all the check reads. */
function png(width: number, height: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("skins", () => {
  const profile = (url: unknown) => ({ id: "x", properties: [{ name: "textures", value: Buffer.from(JSON.stringify({ textures: { SKIN: { url } } })).toString("base64") }] });
  const good = "https://textures.minecraft.net/texture/0123456789abcdef0123456789abcdef";

  it("takes the skin URL from a session-server profile and nothing else", () => {
    expect(skinUrlFromProfile(profile(good))).toBe(good);
    // Mojang's own profiles say http://; it is upgraded.
    expect(skinUrlFromProfile(profile(good.replace("https:", "http:")))).toBe(good);
    for (const bad of ["http://evil.example/texture/0123456789abcdef", "ftp://textures.minecraft.net/texture/0123456789abcdef", "https://evil.example/texture/0123456789abcdef", "https://textures.minecraft.net.evil.example/texture/0123456789abcdef", "https://textures.minecraft.net/texture/../../x", 42, undefined])
      expect(skinUrlFromProfile(profile(bad))).toBeNull();
    expect(skinUrlFromProfile(null)).toBeNull();
    expect(skinUrlFromProfile({ properties: [{ name: "textures", value: "not base64 json" }] })).toBeNull();
  });

  it("accepts only skin-sized PNGs", () => {
    expect(isSkinPng(png(64, 64))).toBe(true);
    expect(isSkinPng(png(64, 32))).toBe(true);
    expect(isSkinPng(png(128, 128))).toBe(false);
    expect(isSkinPng(png(64, 64, 70_000))).toBe(false);
    expect(isSkinPng(Buffer.from("<html>"))).toBe(false);
  });

  it("recognises Mojang-issued (version 4) UUIDs and not offline-mode ones", () => {
    expect(isMojangUuid("61699b2e-d327-4a01-9f1e-0ea8c3f06bc6")).toBe(true);
    expect(isMojangUuid("dd86bbc4-3c76-361f-8118-9cbe503cc245")).toBe(false);
    expect(isMojangUuid("../../etc/passwd")).toBe(false);
  });
});
