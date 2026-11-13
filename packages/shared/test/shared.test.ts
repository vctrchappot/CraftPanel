import { describe, expect, it } from "vitest";
import { can, commandSchema, createServerSchema, jvmArgsSchema, levelNameSchema } from "../src";

describe("RBAC", () => {
  it("orders roles viewer < operator < admin < owner", () => {
    expect(can("viewer", "server.view")).toBe(true);
    expect(can("viewer", "server.control")).toBe(false);
    expect(can("operator", "server.control")).toBe(true);
    expect(can("operator", "server.kill")).toBe(false);
    expect(can("admin", "files.write")).toBe(true);
    expect(can("admin", "users.manage")).toBe(false);
    expect(can("owner", "users.manage")).toBe(true);
  });
});

describe("schemas", () => {
  it("rejects shell metacharacters and memory flags in JVM args", () => {
    expect(jvmArgsSchema.safeParse("-XX:+UseG1GC -Dfoo=bar").success).toBe(true);
    expect(jvmArgsSchema.safeParse("-XX:+UseG1GC; rm -rf /").success).toBe(false);
    expect(jvmArgsSchema.safeParse("$(whoami)").success).toBe(false);
    expect(jvmArgsSchema.safeParse("-Xmx64G").success).toBe(false);
    expect(jvmArgsSchema.safeParse("-jar other.jar").success).toBe(false);
  });
  it("rejects multi-line console commands", () => {
    expect(commandSchema.safeParse({ command: "say hi" }).success).toBe(true);
    expect(commandSchema.safeParse({ command: "say hi\nop Mallory" }).success).toBe(false);
  });
  it("validates world names", () => {
    expect(levelNameSchema.safeParse("world").success).toBe(true);
    expect(levelNameSchema.safeParse("..").success).toBe(false);
    expect(levelNameSchema.safeParse("../etc").success).toBe(false);
  });
  it("applies wizard defaults", () => {
    const r = createServerSchema.parse({ name: "x", software: "paper", mcVersion: "1.21.11" });
    expect(r).toMatchObject({ port: 25565, memoryMb: 2048, acceptEula: false, networkMode: "lan", onlineMode: true });
  });
});

describe("resource limits", () => {
  it("defaults to a protective memory cap and process limit without a CPU limit", async () => {
    const { effectiveLimits, defaultMemoryCap, memoryCapProblem } = await import("../src/limits");
    expect(defaultMemoryCap(1024)).toBe(2048);
    expect(defaultMemoryCap(8192)).toBe(12288);
    expect(effectiveLimits({ memoryMb: 4096, limitMemoryMb: null, limitCpuPercent: null, limitProcesses: null })).toEqual({ memoryMb: 6144, tasks: 4096 });
    expect(effectiveLimits({ memoryMb: 4096, limitMemoryMb: 0, limitCpuPercent: 200, limitProcesses: 0 })).toEqual({ cpuPercent: 200 });
    expect(memoryCapProblem(4096, 4200)).toMatch(/4352 MB/);
    expect(memoryCapProblem(4096, 0)).toBeNull();
  });
});
