import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createZip } from "@craftpanel/backup";
import { findInstalledAddon } from "@craftpanel/shared";
import { hasOwnLog4jSettings, log4shellMitigation } from "../src/log4shell";
import { DuplicateAddonError, findDuplicateAddon, inspectPluginJar, installModrinthVersion, listPlugins } from "../src/plugins";
import { assertTrustedUrl } from "../src/download";
import { fabricLauncherUrl } from "../src/fabric";

describe("log4shellMitigation", () => {
  it("follows Mojang's guidance per version range", () => {
    expect(log4shellMitigation("1.18")).toMatchObject({ kind: "jvm-flag", jvmArgs: ["-Dlog4j2.formatMsgNoLookups=true"] });
    expect(log4shellMitigation("1.18-pre1")?.kind).toBe("jvm-flag");
    expect(log4shellMitigation("1.17.1")?.kind).toBe("jvm-flag");
    expect(log4shellMitigation("1.16.5")).toMatchObject({ kind: "log-config", jvmArgs: ["-Dlog4j.configurationFile=log4j2_112-116.xml"] });
    expect(log4shellMitigation("1.12")?.configFile?.name).toBe("log4j2_112-116.xml");
    expect(log4shellMitigation("1.11.2")?.configFile?.name).toBe("log4j2_17-111.xml");
    expect(log4shellMitigation("1.7.10")?.configFile?.name).toBe("log4j2_17-111.xml");
    expect(log4shellMitigation("1.14 Pre-Release 2")?.configFile?.name).toBe("log4j2_112-116.xml");
    expect(log4shellMitigation("21w37a")?.configFile?.name).toBe("log4j2_17-111.xml");
  });
  it("leaves fixed and unaffected versions alone", () => {
    for (const v of ["1.18.1", "1.18.2", "1.21.11", "26.3", "1.6.4", "1.0", "22w03a", "b1.7.3"]) expect(log4shellMitigation(v)).toBeNull();
  });
  it("downloads the config only from Mojang", () => {
    for (const v of ["1.16.5", "1.8.9"]) expect(() => assertTrustedUrl(log4shellMitigation(v)!.configFile!.url)).not.toThrow();
  });
  it("respects the user's own log4j settings", () => {
    expect(hasOwnLog4jSettings(["-Xss2M", "-Dlog4j.configurationFile=my.xml"])).toBe(true);
    expect(hasOwnLog4jSettings(["-Dlog4j2.formatMsgNoLookups=true"])).toBe(true);
    expect(hasOwnLog4jSettings(["-XX:+UseG1GC"])).toBe(false);
  });
});

describe("Fabric", () => {
  it("builds launcher URLs only from safe version strings", () => {
    expect(fabricLauncherUrl("1.21.11", "0.18.1", "1.1.0")).toBe("https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.18.1/1.1.0/server/jar");
    expect(() => fabricLauncherUrl("../x", "0.18.1", "1.1.0")).toThrow();
    expect(() => assertTrustedUrl(fabricLauncherUrl("1.21.11", "0.18.1", "1.1.0"))).not.toThrow();
  });
});

describe("listPlugins (mods)", () => {
  const root = path.join(os.tmpdir(), `cp-mods-${process.pid}`);
  afterAll(() => fsp.rm(root, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllGlobals());

  async function jar(dir: string, file: string, entries: Record<string, string>) {
    const src = path.join(root, "src", `${dir}-${file}`);
    await fsp.mkdir(src, { recursive: true });
    for (const [name, content] of Object.entries(entries)) await fsp.writeFile(path.join(src, name), content);
    const dest = path.join(root, dir, file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await createZip({ sourceDir: src, destination: dest });
    return dest;
  }

  it("reads fabric.mod.json and resolves dependencies by mod id", async () => {
    await jar("mods", "fabric-api.jar", { "fabric.mod.json": JSON.stringify({ id: "fabric-api", name: "Fabric API", version: "0.140.0", authors: ["FabricMC"], depends: { fabricloader: ">=0.17" } }) });
    await jar("mods", "lithium.jar", {
      "fabric.mod.json": JSON.stringify({ id: "lithium", name: "Lithium", version: "0.18.0", authors: [{ name: "jellysquid3" }], depends: { minecraft: "1.21.11", "fabric-api-base": "*", java: ">=21" } }),
    });
    // Raw line breaks inside strings are common in hand-written fabric.mod.json files.
    await jar("mods", "needs-cloth.jar", { "fabric.mod.json": '{ "id": "needs-cloth", "description": "line one\nline two", "depends": { "cloth-config": "*" }, "suggests": { "modmenu": "*" } }' });
    await jar("mods", "not-a-mod.jar", { "readme.txt": "hi" });

    const mods = await listPlugins(path.join(root, "mods"), "mods");
    const byFile = Object.fromEntries(mods.map((m) => [m.file, m]));
    expect(byFile["lithium.jar"]).toMatchObject({ name: "Lithium", version: "0.18.0", authors: ["jellysquid3"], depend: ["fabric-api-base"], missingDependencies: [] });
    expect(byFile["needs-cloth.jar"]).toMatchObject({ name: "needs-cloth", description: "line one line two", missingDependencies: ["cloth-config"], softDepend: ["modmenu"] });
    expect(byFile["not-a-mod.jar"].name).toBeNull();

    // Without Fabric API, its modules are missing.
    await fsp.rename(path.join(root, "mods", "fabric-api.jar"), path.join(root, "mods", "fabric-api.jar.disabled"));
    const again = await listPlugins(path.join(root, "mods"), "mods");
    expect(again.find((m) => m.file === "lithium.jar")?.missingDependencies).toEqual(["fabric-api-base"]);
  });

  it("flags duplicate plugin jars and prevents installing a second copy of the same plugin", async () => {
    const pluginsDir = path.join(root, "plugins");
    await jar("plugins", "LuckPerms-Bukkit-5.4.100.jar", {
      "plugin.yml": "name: LuckPerms\nversion: 5.4.100\nmain: me.lucko.luckperms.bukkit.LPBukkitBootstrap\n",
    });
    const candidatePath = await jar("tmp", "LuckPerms-Bukkit-5.4.102.jar", {
      "plugin.yml": "name: LuckPerms\nversion: 5.4.102\nmain: me.lucko.luckperms.bukkit.LPBukkitBootstrap\n",
    });

    const existing = await listPlugins(pluginsDir, "plugins");
    const candidate = await inspectPluginJar(candidatePath);
    expect(findDuplicateAddon(candidate, existing, "plugins")?.file).toBe("LuckPerms-Bukkit-5.4.100.jar");
    expect(findDuplicateAddon(candidate, existing, "plugins", "fabric", "LuckPerms-Bukkit-5.4.100.jar")).toBeUndefined();

    // Even when a new version has a different filename and hash, installModrinthVersion refuses to place a duplicate jar alongside the existing one.
    const buf = await fsp.readFile(candidatePath);
    const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
    const sha512 = crypto.createHash("sha512").update(buf).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/version/v102")) {
          return new Response(
            JSON.stringify({
              id: "v102",
              project_id: "Vebnzrzj",
              name: "5.4.102",
              version_number: "5.4.102",
              game_versions: ["1.21.11"],
              loaders: ["paper"],
              version_type: "release",
              date_published: "2026-11-01T00:00:00Z",
              dependencies: [],
              files: [{ url: "https://cdn.modrinth.com/data/Vebnzrzj/versions/v102/LuckPerms-Bukkit-5.4.102.jar", filename: "LuckPerms-Bukkit-5.4.102.jar", primary: true, size: buf.length, hashes: { sha1, sha512 } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(buf, { status: 200, headers: { "content-length": String(buf.length) } });
      }),
    );

    await expect(installModrinthVersion("v102", pluginsDir, { kind: "plugins" })).rejects.toThrow(DuplicateAddonError);
    expect(await fsp.readdir(pluginsDir)).toEqual(["LuckPerms-Bukkit-5.4.100.jar"]);

    // Updating the existing jar with replaceFile succeeds.
    const updated = await installModrinthVersion("v102", pluginsDir, { kind: "plugins", replaceFile: "LuckPerms-Bukkit-5.4.100.jar" });
    expect(updated.file).toBe("LuckPerms-Bukkit-5.4.102.jar");

    // When both jars remain on disk (e.g. copied manually), listPlugins marks each with duplicateOf.
    const both = await listPlugins(pluginsDir, "plugins");
    expect(both).toHaveLength(2);
    expect(both.find((p) => p.file === "LuckPerms-Bukkit-5.4.100.jar")?.duplicateOf).toBe("LuckPerms-Bukkit-5.4.102.jar");
    expect(both.find((p) => p.file === "LuckPerms-Bukkit-5.4.102.jar")?.duplicateOf).toBe("LuckPerms-Bukkit-5.4.100.jar");
  });

  it("matches marketplace hits against installed plugins without false positives", () => {
    const installed = [
      { file: "ViaVersion-5.12.2.jar", name: "ViaVersion", main: "com.viaversion.viaversion.ViaVersionPlugin", projectId: "P1OZGk5p" },
      { file: "simple-voice-chat-paper-2.5.0.jar.disabled", name: "voicechat", main: "de.maxhenkel.voicechat.Voicechat", projectId: "9eGKb6K1" },
      { file: "fabric-api-0.140.0.jar", name: "Fabric API", main: "fabric-api", projectId: null },
    ];
    expect(findInstalledAddon({ id: "P1OZGk5p", slug: "viaversion", title: "ViaVersion", source: "modrinth" }, installed)?.file).toBe("ViaVersion-5.12.2.jar");
    // Hangar hit for ViaVersion matches even when installed from Modrinth:
    expect(findInstalledAddon({ id: "ViaVersion", slug: "ViaVersion", title: "ViaVersion", source: "hangar" }, installed)?.file).toBe("ViaVersion-5.12.2.jar");
    // ViaBackwards must NOT false-match ViaVersion:
    expect(findInstalledAddon({ id: "ViaBackwards", slug: "viabackwards", title: "ViaBackwards", source: "modrinth" }, installed)).toBeUndefined();
    // Matched by recorded projectId even when plugin.yml name ("voicechat") differs from title ("Simple Voice Chat"):
    expect(findInstalledAddon({ id: "9eGKb6K1", slug: "simple-voice-chat", title: "Simple Voice Chat", source: "modrinth" }, installed)?.file).toBe("simple-voice-chat-paper-2.5.0.jar.disabled");
    // Matched by normalized name/modId:
    expect(findInstalledAddon({ id: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", source: "modrinth" }, installed)?.file).toBe("fabric-api-0.140.0.jar");
    // A jar installed from Modrinth is not matched by a different Modrinth project that merely shares its name:
    const veinminer = [{ file: "veinminer-paper-2.6.0.jar", name: "Veinminer", main: null, projectId: "AAAAAAAA", source: "modrinth" as const }];
    expect(findInstalledAddon({ id: "BBBBBBBB", slug: "veinminer", title: "VeinMiner", source: "modrinth" }, veinminer)).toBeUndefined();
    expect(findInstalledAddon({ id: "AAAAAAAA", slug: "vein-miner", title: "VeinMiner", source: "modrinth" }, veinminer)?.file).toBe("veinminer-paper-2.6.0.jar");
    // ...but the same plugin listed on the other source still matches by name:
    expect(findInstalledAddon({ id: "VeinMiner", slug: "VeinMiner", title: "VeinMiner", source: "hangar" }, veinminer)?.file).toBe("veinminer-paper-2.6.0.jar");
  });
});

