import { describe, expect, it } from "vitest";
import { applyPresetFlags, detectPreset, jvmArgsSchema, presetJvmFlags, PRESET_INFO, recommendPreset } from "../src";

describe("performance presets", () => {
  it("produce JVM flags the argument validation accepts", () => {
    for (const p of ["low-power", "balanced", "performance"] as const) for (const mb of [1024, 4096, 16384]) expect(jvmArgsSchema.safeParse(presetJvmFlags(p, mb).join(" ")).success).toBe(true);
  });

  it("size G1 for the heap and skip pre-touching on low-power machines", () => {
    expect(presetJvmFlags("low-power", 1536)).toContain("-XX:G1HeapRegionSize=4M");
    expect(presetJvmFlags("low-power", 1536)).not.toContain("-XX:+AlwaysPreTouch");
    expect(presetJvmFlags("balanced", 4096)).toContain("-XX:+AlwaysPreTouch");
    expect(presetJvmFlags("performance", 16384)).toContain("-XX:G1NewSizePercent=40");
  });

  it("replace earlier GC flags but keep the user's own arguments", () => {
    const before = "-Dfile.encoding=UTF-8 -XX:G1HeapRegionSize=32M -XX:+UseZGC -XX:+AlwaysPreTouch -Dcom.example=1";
    const after = applyPresetFlags(before, "low-power", 2048).split(" ");
    expect(after.slice(0, 2)).toEqual(["-Dfile.encoding=UTF-8", "-Dcom.example=1"]);
    expect(after).not.toContain("-XX:G1HeapRegionSize=32M");
    expect(after).not.toContain("-XX:+AlwaysPreTouch");
    expect(after).not.toContain("-XX:+UseZGC");
    expect(after.filter((a) => a === "-XX:+UseG1GC")).toHaveLength(1);
    // Applying twice changes nothing.
    expect(applyPresetFlags(after.join(" "), "low-power", 2048)).toBe(after.join(" "));
  });

  it("recognise the active preset only when flags and distances match", () => {
    const jvm = applyPresetFlags("-Dx=1", "balanced", 4096);
    const { viewDistance: v, simulationDistance: s } = PRESET_INFO.balanced;
    expect(detectPreset(jvm, 4096, v, s)).toBe("balanced");
    expect(detectPreset(jvm, 4096, 16, s)).toBeNull();
    expect(detectPreset(jvm + " -XX:+UseZGC", 4096, v, s)).toBeNull();
    expect(detectPreset("", 4096, v, s)).toBeNull();
  });

  it("recommend by machine", () => {
    const gb = 1024 ** 3;
    expect(recommendPreset({ arch: "arm64", cpus: 4, memoryBytes: 8 * gb })).toBe("low-power");
    expect(recommendPreset({ arch: "x64", cpus: 2, memoryBytes: 4 * gb })).toBe("low-power");
    expect(recommendPreset({ arch: "x64", cpus: 4, memoryBytes: 8 * gb })).toBe("balanced");
    expect(recommendPreset({ arch: "x64", cpus: 16, memoryBytes: 64 * gb })).toBe("performance");
  });
});
