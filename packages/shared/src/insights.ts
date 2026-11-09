import { PRESET_INFO, type PerformancePreset } from "./performance";
import { SOFTWARE_INFO, type ServerSoftware } from "./software";
import type { HostFit } from "./hardware";
import type { ServerMetrics } from "./types";

/**
 * Performance insights: a short, ranked list of what the live numbers and the current settings say, each with
 * at most one concrete fix. Everything here is derived from data CraftPanel already has (sampled TPS, MSPT, CPU
 * and memory, server settings, the host); it never claims more than that, so wording stays "likely" where the
 * cause can't be known without profiling.
 */
export type InsightLevel = "ok" | "info" | "warning" | "danger";

export type InsightFix =
  /** Only the garbage collector flags of a preset; the view distances stay as they are. */
  | { kind: "gc"; preset: PerformancePreset }
  | { kind: "memory"; memoryMb: number }
  | { kind: "view-distance"; value: number }
  | { kind: "pregen" };

export interface Insight {
  id: string;
  level: InsightLevel;
  title: string;
  detail: string;
  fix?: InsightFix;
}

export interface InsightInput {
  running: boolean;
  software: ServerSoftware;
  /** Recent samples, oldest first (the last few minutes). */
  samples: ServerMetrics[];
  memoryMb: number;
  jvmArgs: string;
  /** From server.properties; null when the key is absent (Minecraft then uses 10). */
  viewDistance: number | null;
  recommendedPreset: PerformancePreset;
  fit: HostFit;
  pregen?: { supported: boolean; installed: boolean } | null;
}

export interface Summary {
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
}

/** Average, extremes and latest value of one metric; samples where it is unavailable are ignored. */
export function summarize(samples: ServerMetrics[], pick: (m: ServerMetrics) => number | null): Summary {
  const v = samples.map(pick).filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return { avg: null, min: null, max: null, last: null };
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] };
}

/** Milliseconds with a decimal while they are small, so a healthy 0.7 ms tick isn't shown as 1 ms. */
const ms = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0));
const RANK: Record<InsightLevel, number> = { danger: 0, warning: 1, info: 2, ok: 3 };
const MINECRAFT_DEFAULT_VIEW = 10;
/** Minutes the samples span, at least one. */
const minutes = (samples: ServerMetrics[]) => Math.max(1, Math.round(((samples[samples.length - 1]?.ts ?? 0) - (samples[0]?.ts ?? 0)) / 60_000));

export function analyzePerformance(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const info = SOFTWARE_INFO[input.software];
  const tps = summarize(input.samples, (m) => m.tps);
  const mspt = summarize(input.samples, (m) => m.mspt);
  const cpu = summarize(input.samples, (m) => m.cpuPercent);
  const ticks = input.samples.filter((m) => m.tps !== null).length;
  const live = input.running && ticks >= 2 && tps.avg !== null;
  const window = minutes(input.samples);

  const lagging = live && tps.avg! < 19;
  const heavyTicks = live && mspt.avg !== null && mspt.avg >= 35;

  if (lagging) {
    const bad = tps.avg! < 15;
    const bound = cpu.max !== null && cpu.max >= 90;
    out.push({
      id: "lag",
      level: bad ? "danger" : "warning",
      title: bad ? "Ticks are falling far behind" : "Ticks are slipping",
      detail:
        `Averaging ${tps.avg!.toFixed(1)} TPS (low ${tps.min!.toFixed(1)})${mspt.avg !== null ? ` at ${ms(mspt.avg)} ms per tick, where 50 ms is the budget` : ""} over the last ${window} min. ` +
        (bound
          ? "One CPU core is close to its limit. The main thread does most of the work, so more cores won't help; a shorter view distance or a pre-generated world takes load off it."
          : "The CPU isn't saturated, so the cause is more likely chunk loading, world saving, plugins or garbage collection."),
    });
  } else if (heavyTicks) {
    out.push({
      id: "headroom",
      level: "warning",
      title: "Little headroom per tick",
      detail: `Ticks take ${ms(mspt.avg!)} ms on average (limit 50 ms). TPS is fine now, but a burst of players, farms or chunk loading can push it below 20.`,
    });
  }

  if (input.fit.level !== "good") {
    const diff = input.fit.suggestedMemoryMb - input.memoryMb;
    out.push({
      id: "host-fit",
      level: input.fit.level === "poor" ? "danger" : "warning",
      title: input.fit.headline,
      detail: [input.fit.summary, input.fit.notes[0]].filter(Boolean).join(" "),
      fix: Math.abs(diff) >= 512 ? { kind: "memory", memoryMb: input.fit.suggestedMemoryMb } : undefined,
    });
  }

  if (!info.proxy) {
    const rec = PRESET_INFO[input.recommendedPreset].viewDistance;
    const view = input.viewDistance ?? MINECRAFT_DEFAULT_VIEW;
    if (view >= rec + 3) {
      const strained = lagging || heavyTicks || input.fit.level !== "good";
      out.push({
        id: "view-distance",
        level: strained ? "warning" : "info",
        title: `View distance ${view} is high for this machine`,
        detail: `${PRESET_INFO[input.recommendedPreset].label} setups usually run at ${rec}. Every extra chunk of distance adds a ring of chunks per player to load, send and keep in memory.`,
        fix: { kind: "view-distance", value: rec },
      });
    }
  }

  // Every preset, and any other collector the owner chose, carries a -XX:+Use…GC flag.
  const hasGc = /(^|\s)-XX:\+Use\w+GC(\s|$)/.test(input.jvmArgs);
  if (!hasGc) {
    out.push({
      id: "gc",
      level: "info",
      title: "Java runs with its default garbage collection",
      detail: "Tuned G1 settings (Aikar's flags) shorten the pauses that show up as lag spikes. They are added next to your own JVM arguments; view distances stay as they are.",
      fix: { kind: "gc", preset: input.recommendedPreset },
    });
  }

  if ((lagging || heavyTicks) && input.pregen?.supported && !input.pregen.installed) {
    out.push({
      id: "pregen",
      level: "info",
      title: "Generating new terrain is likely a big part of the load",
      detail: "Exploring players force the server to generate chunks while it ticks. Pre-generating the area around spawn moves that work to a quiet moment.",
      fix: { kind: "pregen" },
    });
  }

  if ((lagging || heavyTicks) && input.software === "vanilla") {
    out.push({
      id: "software",
      level: "info",
      title: "Paper usually runs the same world faster",
      detail: "Vanilla has no performance optimisations beyond Mojang's own. Paper keeps vanilla gameplay and ticks noticeably cheaper. Switch in Settings → Software & version; your world is kept.",
    });
  }

  if (input.running && !info.proxy && ticks === 0 && input.samples.length >= 4) {
    out.push({
      id: "no-ticks",
      level: "info",
      title: "Tick times aren't available",
      detail: "The first TPS sample arrives after about 15 seconds. Vanilla before 1.20.3 doesn't report tick times at all; CPU and memory are still shown.",
    });
  }

  if (live && !out.some((i) => i.level === "warning" || i.level === "danger")) {
    const players = input.samples[input.samples.length - 1]?.playersOnline ?? 0;
    const room = input.fit.comfortablePlayers;
    out.unshift({
      id: "smooth",
      level: "ok",
      title: "Running smoothly",
      detail:
        `Averaging ${tps.avg!.toFixed(1)} TPS${mspt.avg !== null ? ` at ${ms(mspt.avg)} ms per tick` : ""} over the last ${window} min.` +
        (room !== null ? ` This machine is comfortable with about ${room} players online at once; ${players} ${players === 1 ? "is" : "are"} online now.` : ""),
    });
  }

  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** Highest severity in a list, for a one-word verdict. */
export function overallLevel(insights: Insight[]): InsightLevel {
  return insights.reduce<InsightLevel>((worst, i) => (RANK[i.level] < RANK[worst] ? i.level : worst), "ok");
}
