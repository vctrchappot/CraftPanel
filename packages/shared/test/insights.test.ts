import { describe, expect, it } from "vitest";
import { analyzePerformance, applyPresetFlags, assessHost, overallLevel, summarize, type InsightInput, type ServerMetrics } from "../src";

const sample = (i: number, over: Partial<ServerMetrics> = {}): ServerMetrics => ({ ts: 1_000_000 + i * 15_000, cpuPercent: 30, memoryBytes: 2e9, tps: 20, mspt: 12, uptimeMs: i * 15_000, playersOnline: 3, ...over });
const series = (n: number, over: Partial<ServerMetrics> = {}) => Array.from({ length: n }, (_, i) => sample(i, over));

const host = { arch: "x64", cpus: 8, memoryBytes: 32 * 1024 ** 3 };
const plan = { software: "paper" as const, maxPlayers: 20, viewDistance: 10, memoryMb: 4096 };

/** A healthy Paper server with a preset applied, on a machine that carries it. */
const base = (over: Partial<InsightInput> = {}): InsightInput => ({
  running: true,
  software: "paper",
  samples: series(20),
  memoryMb: 4096,
  jvmArgs: applyPresetFlags("", "balanced", 4096),
  viewDistance: 10,
  recommendedPreset: "balanced",
  fit: assessHost(host, plan),
  pregen: { supported: true, installed: false },
  ...over,
});

const ids = (i: InsightInput) => analyzePerformance(i).map((x) => x.id);

describe("summarize", () => {
  it("ignores unavailable values", () => {
    const s = summarize([sample(0, { tps: null }), sample(1, { tps: 18 }), sample(2, { tps: 20 })], (m) => m.tps);
    expect(s).toEqual({ avg: 19, min: 18, max: 20, last: 20 });
  });
  it("is empty without data", () => {
    expect(summarize([], (m) => m.tps)).toEqual({ avg: null, min: null, max: null, last: null });
  });
});

describe("performance insights", () => {
  it("says a healthy server runs smoothly and nothing else", () => {
    const r = analyzePerformance(base());
    expect(r.map((i) => i.id)).toEqual(["smooth"]);
    expect(overallLevel(r)).toBe("ok");
    expect(r[0].detail).toContain("20.0 TPS");
  });

  it("flags slipping and badly lagging ticks and blames a saturated core only when it is one", () => {
    const slipping = analyzePerformance(base({ samples: series(20, { tps: 17.5, mspt: 52, cpuPercent: 40 }) }))[0];
    expect(slipping.id).toBe("lag");
    expect(slipping.level).toBe("warning");
    expect(slipping.detail).toContain("isn't saturated");
    const bad = analyzePerformance(base({ samples: series(20, { tps: 11, mspt: 90, cpuPercent: 99 }) }))[0];
    expect(bad.level).toBe("danger");
    expect(bad.detail).toContain("more cores won't help");
  });

  it("warns about thin tick headroom while TPS is still fine", () => {
    const r = analyzePerformance(base({ samples: series(20, { tps: 20, mspt: 42 }), pregen: { supported: true, installed: true } }));
    expect(r.map((i) => i.id)).toEqual(["headroom"]);
  });

  it("suggests pre-generation and Paper only when the server is under load", () => {
    const calm = ids(base({ software: "vanilla", jvmArgs: applyPresetFlags("", "balanced", 4096) }));
    expect(calm).not.toContain("pregen");
    expect(calm).not.toContain("software");
    const loaded = ids(base({ software: "vanilla", samples: series(20, { tps: 16, mspt: 60 }) }));
    expect(loaded).toContain("pregen");
    expect(loaded).toContain("software");
    expect(ids(base({ samples: series(20, { tps: 16 }), pregen: { supported: true, installed: true } }))).not.toContain("pregen");
  });

  it("offers a view distance matching the machine, as a hint unless the server is strained", () => {
    const small = { recommendedPreset: "low-power" as const, jvmArgs: applyPresetFlags("", "low-power", 4096), viewDistance: 6 };
    expect(ids(base({ ...small }))).not.toContain("view-distance");
    const high = analyzePerformance(base({ ...small, viewDistance: 16 })).find((i) => i.id === "view-distance")!;
    expect(high.level).toBe("info");
    expect(high.fix).toEqual({ kind: "view-distance", value: 6 });
    const strained = analyzePerformance(base({ ...small, viewDistance: 16, samples: series(20, { tps: 14 }) })).find((i) => i.id === "view-distance")!;
    expect(strained.level).toBe("warning");
    // An unset key means Minecraft's default of 10.
    expect(ids(base({ ...small, viewDistance: null }))).toContain("view-distance");
    // A proxy has no view distance.
    expect(ids(base({ ...small, software: "velocity", viewDistance: null }))).not.toContain("view-distance");
  });

  it("offers tuned GC flags (without touching distances) unless a collector is chosen", () => {
    const plain = base({ jvmArgs: "-Dfile.encoding=UTF-8" });
    expect(analyzePerformance(plain).find((i) => i.id === "gc")?.fix).toEqual({ kind: "gc", preset: "balanced" });
    expect(ids(base({ jvmArgs: "-XX:+UseZGC" }))).not.toContain("gc");
    expect(ids(base())).not.toContain("gc");
  });

  it("raises a host fit problem with a memory fix", () => {
    const small = { arch: "arm64", cpus: 4, memoryBytes: 4 * 1024 ** 3 };
    const fit = assessHost(small, { ...plan, memoryMb: 6144 });
    const r = analyzePerformance(base({ memoryMb: 6144, fit })).find((i) => i.id === "host-fit")!;
    expect(r.level).not.toBe("ok");
    expect(r.fix).toEqual({ kind: "memory", memoryMb: fit.suggestedMemoryMb });
  });

  it("needs a few tick samples and a running server before judging them", () => {
    expect(ids(base({ samples: series(1, { tps: 5 }) }))).not.toContain("lag");
    expect(ids(base({ running: false, samples: series(20, { tps: 5 }) }))).not.toContain("lag");
    expect(ids(base({ samples: series(6, { tps: null, mspt: null }) }))).toContain("no-ticks");
    expect(ids(base({ software: "velocity", samples: series(6, { tps: null, mspt: null }) }))).not.toContain("no-ticks");
  });

  it("orders by severity", () => {
    const r = analyzePerformance(base({ jvmArgs: "", samples: series(20, { tps: 12 }) }));
    const levels = r.map((i) => i.level);
    expect(levels).toEqual([...levels].sort((a, b) => ["danger", "warning", "info", "ok"].indexOf(a) - ["danger", "warning", "info", "ok"].indexOf(b)));
    expect(r[0].id).toBe("lag");
  });
});
