import { PRESET_INFO, recommendPreset } from "./performance";
import { SOFTWARE_INFO, softwareLabel, type ServerSoftware } from "./software";

/**
 * Hardware fit: what a planned server needs and whether this machine can carry it. The plan comes from
 * answers the wizard already collects (software, player slots, view distance), so nobody is asked anything
 * extra. The numbers are rules of thumb for Paper-class servers, rounded and worded as estimates.
 */
export interface HostSpec {
  arch: string;
  cpus: number;
  memoryBytes: number;
  /** Board or machine model when the OS reports one, e.g. "Raspberry Pi 4 Model B Rev 1.4". */
  board?: string | null;
  freeDiskBytes?: number | null;
}

export interface PlanSpec {
  software: ServerSoftware;
  /** Player slots; about 60 % of them are assumed to be online at the same time. */
  maxPlayers: number;
  viewDistance?: number | null;
  modpack?: boolean;
  amplified?: boolean;
  /** Heap the server has or will get; leave out to judge only what the machine can give. */
  memoryMb?: number;
}

/** Servers that already run on this host and share its memory and CPU. */
export interface OtherServers {
  count: number;
  heapMb: number;
}

export type FitLevel = "good" | "tight" | "poor";

export interface HostFit {
  level: FitLevel;
  headline: string;
  summary: string;
  /** At most two short hints, most important first. */
  notes: string[];
  recommendedMemoryMb: number;
  minimumMemoryMb: number;
  /** The recommendation, capped to what the machine can spare. */
  suggestedMemoryMb: number;
  /** Heap this server could get after the OS and the other running servers. */
  availableMemoryMb: number;
  /** Players online at once the CPU carries comfortably; null for proxies. */
  comfortablePlayers: number | null;
}

const STEP = 512;
const roundUp = (mb: number) => Math.ceil(mb / STEP) * STEP;
const roundDown = (mb: number) => Math.floor(mb / STEP) * STEP;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const gb = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;

/** Operating system and panel need room; the JVM uses more than its heap (metaspace, threads). */
const osReserveMb = (totalMb: number) => Math.max(768, Math.round(totalMb * 0.15));
const jvmFootprintMb = (heapMb: number) => Math.round(heapMb * 1.15) + 256;

interface Profile {
  base: number;
  perPlayer: number;
  min: number;
  max: number;
}

function memoryProfile(plan: PlanSpec): Profile {
  if (SOFTWARE_INFO[plan.software].proxy) return { base: 512, perPlayer: 4, min: 512, max: 2048 };
  if (plan.modpack) return { base: 4096, perPlayer: 120, min: 4096, max: 12288 };
  if (plan.software === "neoforge") return { base: 3072, perPlayer: 100, min: 3072, max: 12288 };
  if (plan.software === "fabric") return { base: 1536, perPlayer: 70, min: 2048, max: 12288 };
  return { base: 1024, perPlayer: 80, min: 2048, max: 12288 };
}

const concurrent = (maxPlayers: number) => clamp(Math.ceil(maxPlayers * 0.6), 1, 60);

/** Heap a plan usually needs, in steps of 512 MB. */
export function recommendMemoryMb(plan: PlanSpec): number {
  const p = memoryProfile(plan);
  const view = clamp((plan.viewDistance ?? 10) / 10, 0.7, 1.3);
  return clamp(roundUp(p.base + p.perPlayer * concurrent(plan.maxPlayers) * view + (plan.amplified ? 512 : 0)), p.min, p.max);
}

const SOFTWARE_LOAD: Partial<Record<ServerSoftware, number>> = { vanilla: 0.7, fabric: 0.8, neoforge: 0.5 };

/** Players online at once a host carries comfortably before ticks start to lag. */
function comfortablePlayers(host: HostSpec, plan: PlanSpec, others: OtherServers): number {
  const base = { "low-power": 8, balanced: 24, performance: 60 }[recommendPreset(host)];
  const software = plan.modpack ? 0.4 : (SOFTWARE_LOAD[plan.software] ?? 1);
  const view = clamp(10 / (plan.viewDistance ?? 10), 0.6, 1.5);
  const sharing = 1 / (1 + 0.5 * Math.min(others.count, 3));
  return Math.max(2, Math.round(base * software * view * sharing));
}

const WORSE: Record<FitLevel, number> = { good: 0, tight: 1, poor: 2 };

export function assessHost(host: HostSpec, plan: PlanSpec, others: OtherServers = { count: 0, heapMb: 0 }): HostFit {
  const proxy = SOFTWARE_INFO[plan.software].proxy;
  const totalMb = Math.floor(host.memoryBytes / 1024 / 1024);
  const spareMb = totalMb - osReserveMb(totalMb) - (others.count ? jvmFootprintMb(others.heapMb) + 256 * (others.count - 1) : 0);
  const availableMb = Math.max(0, Math.floor((spareMb - 256) / 1.15));

  const rec = recommendMemoryMb(plan);
  const min = Math.max(1024, Math.min(rec, roundUp(rec * 0.6)));
  const suggested = Math.max(STEP, Math.min(rec, roundDown(availableMb)));
  const have = Math.min(plan.memoryMb ?? Infinity, availableMb);
  let level: FitLevel = have >= rec ? "good" : have >= min ? "tight" : "poor";

  const players = concurrent(plan.maxPlayers);
  const comfortable = proxy ? null : comfortablePlayers(host, plan, others);
  const tooManyPlayers = comfortable !== null && players > comfortable;
  if (tooManyPlayers && WORSE[level] < WORSE.tight) level = "tight";

  const notes: string[] = [];
  if (availableMb < rec) {
    const relief = others.count ? "Stopping other servers, fewer players or a shorter view distance frees up more." : "Fewer players or a shorter view distance need less.";
    notes.push(`Only about ${gb(availableMb)} of memory can be spared here, so ${gb(suggested)} is suggested. ${relief}`);
  } else if (plan.memoryMb !== undefined && plan.memoryMb < rec) {
    notes.push(`${gb(plan.memoryMb)} is below the ${gb(rec)} this setup usually needs.`);
  }
  if (tooManyPlayers) notes.push(`This hardware is comfortable with about ${comfortable} players online at once; more may lag. A shorter view distance helps.`);
  if ((plan.modpack || plan.software === "neoforge") && recommendPreset(host) === "low-power") notes.push("Large modpacks are demanding for ARM boards and small servers.");
  if (host.freeDiskBytes != null && host.freeDiskBytes < 5 * 1024 ** 3) notes.push(`Only ${(host.freeDiskBytes / 1024 ** 3).toFixed(1)} GB of disk is free; worlds and backups grow over time.`);

  const what = plan.modpack ? "This modpack" : softwareLabel(plan.software);
  const where = host.board?.trim() || "this machine";
  // On a big machine the exact free amount is noise.
  const room = availableMb >= rec * 3 ? `${where === "this machine" ? "This machine has" : `${where} has`} plenty of room.` : `About ${gb(availableMb)} is free for servers on ${where}.`;
  const summary = proxy ? `${what} is light. ${room}` : `${what} for ${plan.maxPlayers} player slots needs about ${gb(rec)}. ${room}`;
  // The machine could give enough, but the server is set to less: say so instead of blaming the hardware.
  const underAllocated = plan.memoryMb !== undefined && plan.memoryMb < rec && availableMb >= rec;
  const headline = {
    good: "Fits this machine",
    tight: underAllocated ? "Memory is on the low side" : "Will run, but it is tight",
    poor: underAllocated ? "Not enough memory allocated" : "More than this machine can carry",
  }[level];

  return {
    level,
    headline,
    summary,
    notes: notes.slice(0, 2),
    recommendedMemoryMb: rec,
    minimumMemoryMb: min,
    suggestedMemoryMb: suggested,
    availableMemoryMb: availableMb,
    comfortablePlayers: comfortable,
  };
}

/** The view distance a performance preset sets, for use as a plan input. */
export const presetViewDistance = (preset: keyof typeof PRESET_INFO | null | undefined) => (preset ? PRESET_INFO[preset].viewDistance : null);
