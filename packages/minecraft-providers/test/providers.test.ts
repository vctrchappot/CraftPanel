import { describe, expect, it } from "vitest";
import { gamerulesFromCommandTree } from "../src/gamerules";
import { isJavaCompatible, parseJavaVersion } from "../src/java";
import { parsePluginYaml } from "../src/plugins";
import { assertTrustedUrl } from "../src/download";

describe("gamerulesFromCommandTree", () => {
  it("extracts rule names and types, dropping namespaced duplicates", () => {
    const arg = (parser: string) => ({ children: { value: { type: "argument", parser } }, type: "literal" });
    const tree = {
      type: "root",
      children: {
        gamerule: {
          type: "literal",
          children: {
            keep_inventory: arg("brigadier:bool"),
            "minecraft:keep_inventory": arg("brigadier:bool"),
            random_tick_speed: arg("brigadier:integer"),
            weird: arg("minecraft:resource"),
          },
        },
      },
    };
    expect(gamerulesFromCommandTree(tree)).toEqual([
      { name: "keep_inventory", type: "boolean" },
      { name: "random_tick_speed", type: "integer" },
    ]);
  });
});

describe("Java", () => {
  it("parses `java -version` output", () => {
    expect(parseJavaVersion('openjdk version "25.0.1" 2025-10-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.1+8')).toMatchObject({ major: 25, vendor: "Eclipse Temurin" });
    expect(parseJavaVersion('java version "1.8.0_402"')).toMatchObject({ major: 8 });
    expect(parseJavaVersion("garbage")).toBeNull();
  });
  it("applies the compatibility policy", () => {
    expect(isJavaCompatible(21, 21)).toBe(true);
    expect(isJavaCompatible(21, 25)).toBe(true);
    expect(isJavaCompatible(21, 17)).toBe(false);
    expect(isJavaCompatible(8, 8)).toBe(true);
    expect(isJavaCompatible(8, 21)).toBe(false);
    expect(isJavaCompatible(16, 17)).toBe(true);
  });
});

describe("parsePluginYaml", () => {
  it("reads the fields CraftPanel needs", () => {
    const y = parsePluginYaml(`name: LuckPerms
version: 5.5.71
main: me.lucko.luckperms.bukkit.loader.BukkitLoaderPlugin
api-version: '1.13'
authors: [Luck, Other]
depend:
  - Vault
softdepend: [PlaceholderAPI]
description: "A permissions plugin"
commands:
  lp:
    description: Manage permissions
`);
    expect(y).toMatchObject({ name: "LuckPerms", version: "5.5.71", "api-version": "1.13", authors: ["Luck", "Other"], depend: ["Vault"], softdepend: ["PlaceholderAPI"], description: "A permissions plugin" });
  });
});

describe("assertTrustedUrl", () => {
  it("only allows HTTPS downloads from official sources", () => {
    expect(() => assertTrustedUrl("https://piston-data.mojang.com/v1/objects/x/server.jar")).not.toThrow();
    expect(() => assertTrustedUrl("https://fill-data.papermc.io/v1/objects/x/paper.jar")).not.toThrow();
    expect(() => assertTrustedUrl("http://piston-data.mojang.com/x")).toThrow(/HTTPS/);
    expect(() => assertTrustedUrl("https://evil.example.com/server.jar")).toThrow(/untrusted/);
  });
});
