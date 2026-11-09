import { describe, expect, it } from "vitest";
import { assessHost, recommendMemoryMb } from "../src";

const gb = 1024 ** 3;
const pi4 = { arch: "arm64", cpus: 4, memoryBytes: 4 * gb, board: "Raspberry Pi 4 Model B Rev 1.4" };
const pi5 = { arch: "arm64", cpus: 4, memoryBytes: 8 * gb, board: "Raspberry Pi 5 Model B" };
const desktop = { arch: "x64", cpus: 12, memoryBytes: 32 * gb };

describe("memory recommendation", () => {
  it("sizes by software, players and view distance", () => {
    expect(recommendMemoryMb({ software: "paper", maxPlayers: 5 })).toBe(2048);
    expect(recommendMemoryMb({ software: "paper", maxPlayers: 20 })).toBe(2048);
    expect(recommendMemoryMb({ software: "paper", maxPlayers: 100 })).toBeGreaterThan(4096);
    expect(recommendMemoryMb({ software: "paper", maxPlayers: 20, viewDistance: 6 })).toBeLessThanOrEqual(recommendMemoryMb({ software: "paper", maxPlayers: 20, viewDistance: 12 }));
    expect(recommendMemoryMb({ software: "neoforge", maxPlayers: 10 })).toBeGreaterThanOrEqual(3072);
    expect(recommendMemoryMb({ software: "fabric", maxPlayers: 10, modpack: true })).toBeGreaterThanOrEqual(4096);
    expect(recommendMemoryMb({ software: "velocity", maxPlayers: 500 })).toBeLessThanOrEqual(2048);
  });

  it("always rounds to 512 MB steps", () => {
    for (const players of [1, 7, 13, 33, 80]) expect(recommendMemoryMb({ software: "purpur", maxPlayers: players, viewDistance: 8 }) % 512).toBe(0);
  });
});

describe("host fit", () => {
  it("calls a small Paper server on a Pi a good fit", () => {
    const fit = assessHost(pi4, { software: "paper", maxPlayers: 10, viewDistance: 6 });
    expect(fit.level).toBe("good");
    expect(fit.suggestedMemoryMb).toBe(fit.recommendedMemoryMb);
    expect(fit.summary).toContain("Raspberry Pi 4");
    expect(assessHost(desktop, { software: "paper", maxPlayers: 10 }).summary).toContain("plenty of room");
    expect(fit.notes).toEqual([]);
  });

  it("warns that a modpack is too much for a 4 GB Pi and caps the suggestion", () => {
    const fit = assessHost(pi4, { software: "neoforge", maxPlayers: 10, modpack: true, viewDistance: 6 });
    expect(fit.level).toBe("poor");
    expect(fit.suggestedMemoryMb).toBeLessThan(fit.recommendedMemoryMb);
    expect(fit.suggestedMemoryMb).toBeLessThanOrEqual(fit.availableMemoryMb);
    expect(fit.notes.length).toBeGreaterThan(0);
    expect(fit.notes.length).toBeLessThanOrEqual(2);
  });

  it("is tight when the memory fits but the CPU does not carry the players", () => {
    const fit = assessHost(pi5, { software: "paper", maxPlayers: 60, viewDistance: 10 });
    expect(fit.level).toBe("tight");
    expect(fit.comfortablePlayers).not.toBeNull();
    expect(fit.notes.join(" ")).toContain("players online at once");
  });

  it("lets a powerful desktop carry a modpack", () => {
    expect(assessHost(desktop, { software: "neoforge", maxPlayers: 20, modpack: true }).level).toBe("good");
  });

  it("subtracts memory used by other running servers", () => {
    const alone = assessHost(pi5, { software: "paper", maxPlayers: 20 });
    const shared = assessHost(pi5, { software: "paper", maxPlayers: 20 }, { count: 2, heapMb: 5 * 1024 });
    expect(shared.availableMemoryMb).toBeLessThan(alone.availableMemoryMb);
    expect(shared.level).not.toBe("good");
    expect(shared.notes.join(" ")).toContain("Stopping other servers");
  });

  it("judges the memory the server actually has", () => {
    const low = assessHost(desktop, { software: "paper", maxPlayers: 20, memoryMb: 1024 });
    expect(low.level).not.toBe("good");
    expect(low.notes[0]).toContain("below");
    // The machine is not the problem, so the headline must not say it is:
    expect(low.headline).not.toContain("machine can carry");
    expect(assessHost(desktop, { software: "paper", maxPlayers: 20, memoryMb: 4096 }).level).toBe("good");
  });

  it("does not judge a proxy by players or CPU", () => {
    const fit = assessHost(pi4, { software: "velocity", maxPlayers: 500 });
    expect(fit.level).toBe("good");
    expect(fit.comfortablePlayers).toBeNull();
  });

  it("mentions low disk space", () => {
    const fit = assessHost({ ...desktop, freeDiskBytes: 2 * gb }, { software: "paper", maxPlayers: 10 });
    expect(fit.notes.join(" ")).toContain("disk");
  });

  it("never suggests less than 512 MB, even on a tiny host", () => {
    const fit = assessHost({ arch: "x64", cpus: 1, memoryBytes: 1 * gb }, { software: "paper", maxPlayers: 5 });
    expect(fit.level).toBe("poor");
    expect(fit.suggestedMemoryMb).toBeGreaterThanOrEqual(512);
  });
});
