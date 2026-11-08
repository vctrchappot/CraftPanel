/**
 * Performance presets: JVM garbage-collector flags plus view and simulation distance, the settings
 * that matter most for how many players a small machine can carry. The GC flags are Aikar's
 * widely used G1 tuning (https://docs.papermc.io/paper/aikars-flags); the low-power preset leaves
 * out -XX:+AlwaysPreTouch, which commits the whole heap at start (slow and RAM-hungry on a Pi).
 */
export const PERFORMANCE_PRESETS = ["low-power", "balanced", "performance"] as const;
export type PerformancePreset = (typeof PERFORMANCE_PRESETS)[number];

export interface PresetInfo {
  label: string;
  description: string;
  viewDistance: number;
  simulationDistance: number;
}

export const PRESET_INFO: Record<PerformancePreset, PresetInfo> = {
  "low-power": {
    label: "Raspberry Pi / small VPS",
    description: "View distance 6, simulation distance 4 and GC flags without pre-touching memory. Carries a few players on 2–4 cores.",
    viewDistance: 6,
    simulationDistance: 4,
  },
  balanced: {
    label: "Balanced",
    description: "View distance 10, simulation distance 8 and Aikar's GC flags. A good default for most home servers.",
    viewDistance: 10,
    simulationDistance: 8,
  },
  performance: {
    label: "Powerful machine",
    description: "View distance 12, simulation distance 10 and Aikar's GC flags with pre-touched memory, for 8+ cores and plenty of RAM.",
    viewDistance: 12,
    simulationDistance: 10,
  },
};

const G1_COMMON = ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5", "-XX:SurvivorRatio=32", "-XX:+PerfDisableSharedMem", "-XX:MaxTenuringThreshold=1"];

/** GC flags for a preset and heap size (Aikar uses larger young generations above 12 GB). */
export function presetJvmFlags(preset: PerformancePreset, memoryMb: number): string[] {
  const big = memoryMb >= 12 * 1024;
  const sizing = big
    ? ["-XX:G1NewSizePercent=40", "-XX:G1MaxNewSizePercent=50", "-XX:G1HeapRegionSize=16M", "-XX:G1ReservePercent=15", "-XX:InitiatingHeapOccupancyPercent=20"]
    : ["-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", `-XX:G1HeapRegionSize=${memoryMb <= 2048 ? "4M" : "8M"}`, "-XX:G1ReservePercent=20", "-XX:InitiatingHeapOccupancyPercent=15"];
  return [...G1_COMMON, ...sizing, ...(preset === "low-power" ? [] : ["-XX:+AlwaysPreTouch"])];
}

/** The option name of a JVM flag, so a preset can replace earlier GC flags but keep everything else. */
const flagKey = (arg: string) => arg.replace(/^-XX:[+-]/, "-XX:").replace(/=.*$/, "");
const PRESET_KEYS = new Set([...presetJvmFlags("performance", 4096), ...presetJvmFlags("performance", 16384)].map(flagKey));
// Another garbage collector (-XX:+UseZGC, …) next to G1 would stop the JVM from starting.
const isPresetFlag = (arg: string) => PRESET_KEYS.has(flagKey(arg)) || /^-XX:[+-]Use\w+GC$/.test(arg);

/** Replace the GC flags in a server's JVM arguments with a preset's, keeping all other arguments. */
export function applyPresetFlags(jvmArgs: string, preset: PerformancePreset, memoryMb: number): string {
  const own = jvmArgs.trim() ? jvmArgs.trim().split(/\s+/).filter((a) => !isPresetFlag(a)) : [];
  return [...own, ...presetJvmFlags(preset, memoryMb)].join(" ");
}

/** Which preset a server's current settings match, or null for custom settings. */
export function detectPreset(jvmArgs: string, memoryMb: number, viewDistance: number | null, simulationDistance: number | null): PerformancePreset | null {
  const args = new Set(jvmArgs.trim().split(/\s+/));
  for (const p of PERFORMANCE_PRESETS) {
    const flags = presetJvmFlags(p, memoryMb);
    const gc = [...args].filter(isPresetFlag);
    if (gc.length === flags.length && flags.every((f) => args.has(f)) && viewDistance === PRESET_INFO[p].viewDistance && simulationDistance === PRESET_INFO[p].simulationDistance) return p;
  }
  return null;
}

/** The preset that fits a machine: low-power for ARM boards and small VPS, performance for big hosts. */
export function recommendPreset(host: { arch: string; cpus: number; memoryBytes: number }): PerformancePreset {
  const gb = host.memoryBytes / 1024 ** 3;
  if (host.arch.startsWith("arm") || host.cpus <= 2 || gb <= 4.5) return "low-power";
  if (host.cpus >= 8 && gb >= 15) return "performance";
  return "balanced";
}
