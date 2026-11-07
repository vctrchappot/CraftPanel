import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createZip } from "@craftpanel/backup";
import { hasOwnLog4jSettings, log4shellMitigation } from "../src/log4shell";
import { listPlugins } from "../src/plugins";
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

  async function jar(file: string, entries: Record<string, string>) {
    const src = path.join(root, "src", file);
    await fsp.mkdir(src, { recursive: true });
    for (const [name, content] of Object.entries(entries)) await fsp.writeFile(path.join(src, name), content);
    await createZip({ sourceDir: src, destination: path.join(root, "mods", file) });
  }

  it("reads fabric.mod.json and resolves dependencies by mod id", async () => {
    await jar("fabric-api.jar", { "fabric.mod.json": JSON.stringify({ id: "fabric-api", name: "Fabric API", version: "0.140.0", authors: ["FabricMC"], depends: { fabricloader: ">=0.17" } }) });
    await jar("lithium.jar", {
      "fabric.mod.json": JSON.stringify({ id: "lithium", name: "Lithium", version: "0.18.0", authors: [{ name: "jellysquid3" }], depends: { minecraft: "1.21.11", "fabric-api-base": "*", java: ">=21" } }),
    });
    // Raw line breaks inside strings are common in hand-written fabric.mod.json files.
    await jar("needs-cloth.jar", { "fabric.mod.json": '{ "id": "needs-cloth", "description": "line one\nline two", "depends": { "cloth-config": "*" }, "suggests": { "modmenu": "*" } }' });
    await jar("not-a-mod.jar", { "readme.txt": "hi" });

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
});
