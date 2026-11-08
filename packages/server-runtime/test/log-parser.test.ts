import { describe, expect, it } from "vitest";
import { detectSignal, parseLine, parseListCount, parseMspt, parseTps, stripAnsi } from "../src/log-parser";

describe("parseLine", () => {
  it("parses vanilla log lines", () => {
    expect(parseLine("[12:13:56] [Server thread/INFO]: Done (2.948s)! For help, type \"help\"")).toEqual({ level: "INFO", thread: "Server thread", message: 'Done (2.948s)! For help, type "help"' });
    expect(parseLine("[12:13:56] [Server thread/WARN]: Can't keep up!").level).toBe("WARN");
  });
  it("parses Paper log lines", () => {
    expect(parseLine("[16:11:42 INFO]: [LuckPerms] Enabling LuckPerms v5.5.71")).toMatchObject({ level: "INFO", message: "[LuckPerms] Enabling LuckPerms v5.5.71" });
    expect(parseLine("[16:11:42 ERROR]: Could not load plugin").level).toBe("ERROR");
  });
  it("parses NeoForge console and latest.log lines", () => {
    expect(parseLine('[18:40:20] [Server thread/INFO] [minecraft/DedicatedServer]: Done (7.461s)! For help, type "help"')).toEqual({ level: "INFO", thread: "Server thread", message: 'Done (7.461s)! For help, type "help"' });
    expect(parseLine("[08Nov2026 18:40:15.433] [Server thread/WARN] [net.minecraft.server.dedicated.DedicatedServer/]: **** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!")).toMatchObject({ level: "WARN", message: "**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!" });
    expect(parseLine("[18:41:02] [Server thread/INFO] [minecraft/MinecraftServer]: Steve joined the game").message).toBe("Steve joined the game");
    // The date follows the JVM's locale.
    expect(parseLine("[08Nov.2026 18:41:44.828] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: Done (7.740s)!").message).toBe("Done (7.740s)!");
  });
  it("normalises the 26.x 'System chat:' prefix for matching", () => {
    expect(parseLine("[12:14:28] [Server thread/INFO]: System chat: Saved the game").message).toBe("Saved the game");
  });
  it("strips ANSI and section colour codes", () => {
    expect(stripAnsi("\u001b[33m§aHello\u001b[0m")).toBe("Hello");
  });
});

describe("detectSignal", () => {
  it("recognises lifecycle and player events", () => {
    expect(detectSignal('Done (3.037s)! For help, type "help"')).toEqual({ kind: "done", seconds: 3.037 });
    expect(detectSignal("Steve joined the game")).toEqual({ kind: "join", name: "Steve" });
    expect(detectSignal("Alex left the game")).toEqual({ kind: "leave", name: "Alex" });
    expect(detectSignal("Steve[/192.168.1.5:54321] logged in with entity id 1 at (0, 64, 0)")).toEqual({ kind: "login", name: "Steve", ip: "192.168.1.5" });
    expect(detectSignal("**** FAILED TO BIND TO PORT!")?.kind).toBe("port-in-use");
    expect(detectSignal("You need to agree to the EULA in order to run the server.")?.kind).toBe("eula");
  });
  it("does not treat chat impersonation as a join", () => {
    expect(detectSignal("<Mallory> Steve joined the game")).toBeNull();
  });
});

describe("metric parsers", () => {
  it("parses Paper TPS and vanilla MSPT", () => {
    expect(parseTps("TPS from last 1m, 5m, 15m: *20.0, 19.98, 20.0")).toBe(20);
    expect(parseMspt("Average time per tick: 1.2ms (Target: 50.0ms)")).toBe(1.2);
  });
  it("parses player list output from both vanilla and Paper", () => {
    expect(parseListCount("There are 1 of a max of 20 players online: Steve")).toEqual({ online: 1, max: 20, names: ["Steve"] });
    expect(parseListCount("There are 0 out of maximum 10 players online.")).toMatchObject({ online: 0, max: 10 });
  });
});
