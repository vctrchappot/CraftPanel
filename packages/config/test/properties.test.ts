import { describe, expect, it } from "vitest";
import { PropertiesDocument } from "../src/properties";
import { validateSetting } from "../src/catalog";

const SAMPLE = `#Minecraft server properties
#Fri Nov 07 12:13:52 CET 2026
accepts-transfers=false
level-type=minecraft\\:normal
motd=A Minecraft Server
server-port=25565
generator-settings={}
custom.plugin.key = some value
`;

describe("PropertiesDocument", () => {
  it("parses Java escapes and separators", () => {
    const d = PropertiesDocument.parse(SAMPLE);
    expect(d.get("level-type")).toBe("minecraft:normal");
    expect(d.get("motd")).toBe("A Minecraft Server");
    expect(d.get("custom.plugin.key")).toBe("some value");
  });

  it("preserves comments, order and unknown keys when editing", () => {
    const d = PropertiesDocument.parse(SAMPLE);
    d.set("motd", "Hello: world = yes");
    d.set("new-key", "1");
    const out = d.serialize();
    expect(out.startsWith("#Minecraft server properties\n#Fri Nov 07")).toBe(true);
    expect(out).toContain("motd=Hello\\: world \\= yes");
    expect(out).toContain("custom.plugin.key=some value");
    expect(out.trim().endsWith("new-key=1")).toBe(true);
    expect(PropertiesDocument.parse(out).get("motd")).toBe("Hello: world = yes");
  });

  it("round-trips unicode", () => {
    const d = new PropertiesDocument();
    d.set("motd", "Grüße §aGrün ✓");
    expect(PropertiesDocument.parse(d.serialize()).get("motd")).toBe("Grüße §aGrün ✓");
  });

  it("handles continuation lines and CRLF", () => {
    const d = PropertiesDocument.parse("a=one\\\r\n   two\r\nb=3\r\n");
    expect(d.get("a")).toBe("onetwo");
    expect(d.get("b")).toBe("3");
  });

  it("refuses multi-line values (no injection of extra keys)", () => {
    const d = new PropertiesDocument();
    expect(() => d.set("motd", "x\nenable-rcon=true")).toThrow();
  });
});

describe("validateSetting", () => {
  it("validates by type", () => {
    expect(validateSetting("max-players", "20")).toBeNull();
    expect(validateSetting("max-players", "0")).toMatch(/at least/);
    expect(validateSetting("max-players", "abc")).toMatch(/whole number/);
    expect(validateSetting("pvp", "yes")).toMatch(/true or false/);
    expect(validateSetting("difficulty", "hard")).toBeNull();
    expect(validateSetting("difficulty", "insane")).toMatch(/one of/);
    expect(validateSetting("motd", "a\nb")).toMatch(/single line/);
    expect(validateSetting("unknown-key", "anything")).toBeNull();
  });
});
