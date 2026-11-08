import { describe, expect, it } from "vitest";
import { argsFileForPlatform, neoForgeArgsFile, neoForgeMinecraftVersion } from "../src/neoforge";
import { parseModsToml } from "../src/plugins";

describe("neoForgeMinecraftVersion", () => {
  it("maps the scheme up to 1.21.x (leading 1. dropped)", () => {
    expect(neoForgeMinecraftVersion("21.1.172")).toBe("1.21.1");
    expect(neoForgeMinecraftVersion("21.0.167")).toBe("1.21");
    expect(neoForgeMinecraftVersion("20.4.253")).toBe("1.20.4");
    expect(neoForgeMinecraftVersion("21.11.48")).toBe("1.21.11");
    expect(neoForgeMinecraftVersion("20.5.21-beta")).toBe("1.20.5");
  });
  it("maps the 26.x scheme (game version plus build)", () => {
    expect(neoForgeMinecraftVersion("26.1.2.126")).toBe("26.1.2");
    expect(neoForgeMinecraftVersion("26.3.0.101")).toBe("26.3");
    expect(neoForgeMinecraftVersion("26.1.0.19-beta")).toBe("26.1");
  });
  it("ignores anything else", () => {
    expect(neoForgeMinecraftVersion("0.25w14craftmine.5-beta")).toBeNull();
    expect(neoForgeMinecraftVersion("26.3")).toBeNull();
    expect(neoForgeMinecraftVersion("../../x")).toBeNull();
  });
});

describe("argument files", () => {
  it("names the installer's launch file per OS", () => {
    expect(neoForgeArgsFile("21.1.172", "linux")).toBe("libraries/net/neoforged/neoforge/21.1.172/unix_args.txt");
    expect(neoForgeArgsFile("21.1.172", "win32")).toBe("libraries/net/neoforged/neoforge/21.1.172/win_args.txt");
    expect(() => neoForgeArgsFile("21.1.172/../../evil")).toThrow();
    expect(argsFileForPlatform("libraries/x/unix_args.txt", "win32")).toBe("libraries/x/win_args.txt");
    expect(argsFileForPlatform("libraries/x/win_args.txt", "linux")).toBe("libraries/x/unix_args.txt");
  });
});

describe("parseModsToml", () => {
  const toml = `
modLoader="javafml" #mandatory
loaderVersion="[4,)"
license="MIT"

[[mods]]
modId="examplemod"
version="\${file.jarVersion}"
displayName="Example Mod"
authors="Alice, Bob"
description='''
A mod that
does things.
'''

[[mixins]]
config="examplemod.mixins.json"

[[dependencies.examplemod]]
    modId="neoforge"
    type="required"
    versionRange="[21.1,)"
[[dependencies.examplemod]]
    modId="geckolib"
    type="required"
[[dependencies.examplemod]]
    modId="jei"
    type="optional"
`;
  it("accepts the template's trailing comments on table headers", () => {
    const r = parseModsToml('[[mods]] #mandatory\nmodId="statuseffectbars" #mandatory\n[[dependencies.statuseffectbars]] #optional\nmodId="neoforge" #mandatory\ntype="required" #mandatory\n');
    expect(r.mods).toEqual([{ modId: "statuseffectbars" }]);
    expect(r.dependencies).toEqual([{ modId: "neoforge", type: "required" }]);
  });
  it("reads mods and dependencies", () => {
    const r = parseModsToml(toml);
    expect(r.mods).toEqual([{ modId: "examplemod", version: "${file.jarVersion}", displayName: "Example Mod", authors: "Alice, Bob", description: "A mod that does things." }]);
    expect(r.dependencies.map((d) => `${d.modId}:${d.type}`)).toEqual(["neoforge:required", "geckolib:required", "jei:optional"]);
  });
});
