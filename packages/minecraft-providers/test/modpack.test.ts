import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createZip, resolveInside } from "@craftpanel/backup";
import { describeModpack, installModpack, readModpack, type MrpackFile } from "../src/modpack";

const sha512 = "a".repeat(128);
const file = (p: string, extra: Partial<MrpackFile> = {}): MrpackFile => ({ path: p, hashes: { sha1: "b".repeat(40), sha512 }, downloads: [`https://cdn.modrinth.com/data/x/${p}`], fileSize: 1000, ...extra });
const pack = (over: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  game: "minecraft",
  versionId: "1.2.0",
  name: "Test Pack",
  summary: "For tests",
  files: [file("mods/lithium.jar"), file("mods/sodium.jar", { env: { client: "required", server: "unsupported" } }), file("config/x.json", { env: { client: "optional", server: "required" } })],
  dependencies: { minecraft: "1.21.11", "fabric-loader": "0.18.1" },
  ...over,
});

describe("describeModpack", () => {
  it("describes a Fabric pack and skips client-only files", () => {
    const { info } = describeModpack(pack());
    expect(info).toMatchObject({ name: "Test Pack", version: "1.2.0", mcVersion: "1.21.11", software: "fabric", loader: "0.18.1", serverFiles: 2, clientOnlyFiles: 1, downloadBytes: 2000 });
  });
  it("treats a pack without a loader as vanilla", () => {
    expect(describeModpack(pack({ files: [], dependencies: { minecraft: "1.21.11" } })).info).toMatchObject({ software: "vanilla", loader: null });
  });
  it("runs NeoForge packs on NeoForge", () => {
    expect(describeModpack(pack({ dependencies: { minecraft: "1.21.1", neoforge: "21.1.172" } })).info).toMatchObject({ software: "neoforge", loader: "21.1.172", mcVersion: "1.21.1" });
    expect(() => describeModpack(pack({ dependencies: { minecraft: "1.21.1", neoforge: "21.1.172", "fabric-loader": "0.16.0" } }))).toThrow(/both/);
  });
  it("names loaders CraftPanel can't run", () => {
    expect(() => describeModpack(pack({ dependencies: { minecraft: "1.20.1", forge: "47.2.0" } }))).toThrow(/needs Forge/);
    expect(() => describeModpack(pack({ dependencies: { minecraft: "1.21.1", "quilt-loader": "0.26" } }))).toThrow(/Quilt/);
  });
  it("rejects files outside the usual folders or with traversal", () => {
    for (const p of ["../evil.jar", "mods/../../evil.jar", "server.jar", "/etc/passwd", "mods\\..\\x.jar", "mods//x.jar"]) expect(() => describeModpack(pack({ files: [file(p)] })), p).toThrow(/unexpected file/);
  });
  it("only accepts the download hosts the format allows, over HTTPS, with SHA-512", () => {
    expect(() => describeModpack(pack({ files: [file("mods/a.jar", { downloads: ["https://evil.example/a.jar"] })] }))).toThrow(/host/);
    expect(() => describeModpack(pack({ files: [file("mods/a.jar", { downloads: ["http://cdn.modrinth.com/a.jar"] })] }))).toThrow(/host/);
    expect(() => describeModpack(pack({ files: [file("mods/a.jar", { hashes: { sha1: "b".repeat(40) } })] }))).toThrow(/SHA-512/);
    // Client-only files are never downloaded, so they aren't checked.
    expect(describeModpack(pack({ files: [file("../client.jar", { env: { server: "unsupported" } })] })).info.serverFiles).toBe(0);
  });
  it("rejects things that aren't modpacks", () => {
    expect(() => describeModpack({ formatVersion: 2, game: "minecraft", files: [], dependencies: {} })).toThrow(/not a Modrinth modpack/);
    expect(() => describeModpack(pack({ dependencies: {} }))).toThrow(/Minecraft version/);
  });
});

describe("readModpack / installModpack", () => {
  const root = fsp.mkdtemp(path.join(os.tmpdir(), "cp-mrpack-"));
  afterAll(async () => fsp.rm(await root, { recursive: true, force: true }));

  it("extracts overrides, then server-overrides on top", async () => {
    const dir = await root;
    const src = path.join(dir, "src");
    await fsp.mkdir(path.join(src, "overrides", "config"), { recursive: true });
    await fsp.mkdir(path.join(src, "server-overrides", "config"), { recursive: true });
    await fsp.mkdir(path.join(src, "client-overrides", "config"), { recursive: true });
    await fsp.writeFile(path.join(src, "modrinth.index.json"), JSON.stringify(pack({ files: [file("mods/sodium.jar", { env: { server: "unsupported" } })] })));
    await fsp.writeFile(path.join(src, "overrides", "config", "a.txt"), "common");
    await fsp.writeFile(path.join(src, "overrides", "config", "b.txt"), "common");
    await fsp.writeFile(path.join(src, "server-overrides", "config", "a.txt"), "server");
    await fsp.writeFile(path.join(src, "client-overrides", "config", "c.txt"), "client");
    const mrpack = path.join(dir, "pack.mrpack");
    await createZip({ sourceDir: src, destination: mrpack });

    expect((await readModpack(mrpack)).info.name).toBe("Test Pack");
    const server = path.join(dir, "server");
    await fsp.mkdir(server);
    const result = await installModpack(mrpack, server, async (rel) => resolveInside(server, rel));
    expect(result).toEqual({ files: 0, overrides: 3 });
    expect(await fsp.readFile(path.join(server, "config", "a.txt"), "utf8")).toBe("server");
    expect(await fsp.readFile(path.join(server, "config", "b.txt"), "utf8")).toBe("common");
    await expect(fsp.access(path.join(server, "config", "c.txt"))).rejects.toThrow();
  });

  it("explains files that aren't modpacks", async () => {
    const dir = await root;
    const junk = path.join(dir, "junk.mrpack");
    await fsp.writeFile(junk, "not a zip");
    await expect(readModpack(junk)).rejects.toThrow(/not a valid .mrpack/);
    const src = path.join(dir, "empty");
    await fsp.mkdir(src);
    await fsp.writeFile(path.join(src, "readme.txt"), "hi");
    const zip = path.join(dir, "empty.mrpack");
    await createZip({ sourceDir: src, destination: zip });
    await expect(readModpack(zip)).rejects.toThrow(/modrinth.index.json is missing/);
  });
});
