import fs from "node:fs";
import os from "node:os";

/** What CraftPanel knows about the machine it runs on, used to size and judge servers. */
export interface HostInfo {
  arch: string;
  /** Cores this process may use (respects CPU affinity and container quotas where Node reports them). */
  cpus: number;
  cpuModel: string | null;
  /** Memory servers can really use: the container limit when there is one, else the installed RAM. */
  memoryBytes: number;
  /** Installed RAM as the OS reports it. */
  physicalMemoryBytes: number;
  /** True when a container or cgroup limit is lower than the installed RAM. */
  memoryLimited: boolean;
  /** Board or machine model (Raspberry Pi, …) when the OS reports one. */
  board: string | null;
}

/** A cgroup memory limit file's content: a byte count, or null for "max" and the huge "unlimited" values of cgroup v1. */
export function parseCgroupLimit(text: string | null | undefined): number | null {
  const v = (text ?? "").trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n < 2 ** 50 ? n : null;
}

/** A device-tree or DMI model string without the NUL padding the kernel adds. */
export function cleanBoardName(text: string | null | undefined): string | null {
  const v = (text ?? "").replace(/\0/g, "").trim();
  return v && !/^(to be filled|default string|system product name|none|unknown)/i.test(v) ? v.slice(0, 80) : null;
}

const read = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

function linuxMemoryLimit(): number | null {
  // cgroup v2, then v1 (the cgroup of this process is mounted at the standard place inside containers).
  return parseCgroupLimit(read("/sys/fs/cgroup/memory.max")) ?? parseCgroupLimit(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
}

function linuxBoard(): string | null {
  return cleanBoardName(read("/proc/device-tree/model") ?? read("/sys/firmware/devicetree/base/model")) ?? cleanBoardName(/^Model\s*:\s*(.+)$/m.exec(read("/proc/cpuinfo") ?? "")?.[1]);
}

let cached: HostInfo | null = null;

/** Detect the host once; hardware and container limits don't change while the process runs. */
export function detectHost(): HostInfo {
  if (cached) return cached;
  const physical = os.totalmem();
  const limit = process.platform === "linux" ? linuxMemoryLimit() : null;
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  cached = {
    arch: process.arch,
    cpus: Math.max(1, cpus || os.cpus().length),
    cpuModel: os.cpus()[0]?.model?.trim() || null,
    memoryBytes: limit && limit < physical ? limit : physical,
    physicalMemoryBytes: physical,
    memoryLimited: !!limit && limit < physical,
    board: process.platform === "linux" ? linuxBoard() : null,
  };
  return cached;
}
