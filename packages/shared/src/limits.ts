/**
 * Per-server resource limits. A server stores three settings; `null` means the default:
 * a protective memory cap and process limit, and no CPU limit. `0` turns a cap off.
 */
export interface LimitSettings {
  /** Hard memory cap for the whole process in MB; null: heap plus headroom, 0: none. */
  limitMemoryMb: number | null;
  /** CPU time in percent of one core; null: unlimited. */
  limitCpuPercent: number | null;
  /** Processes and threads; null: {@link DEFAULT_TASK_LIMIT}, 0: none. */
  limitProcesses: number | null;
}

/** What the runtime enforces; absent fields are unlimited. */
export interface EffectiveLimits {
  memoryMb?: number;
  cpuPercent?: number;
  tasks?: number;
}

/** Plenty for a modded server (a few hundred threads) and still stops a fork bomb. */
export const DEFAULT_TASK_LIMIT = 4096;
/** Below this headroom over the heap the JVM itself (metaspace, threads, buffers) does not fit. */
export const MIN_MEMORY_HEADROOM_MB = 256;

/** Java needs memory beyond the heap; the default cap leaves at least 1 GB or half the heap on top. */
export function defaultMemoryCap(heapMb: number): number {
  return heapMb + Math.max(1024, Math.ceil(heapMb / 2));
}

export function effectiveLimits(s: LimitSettings & { memoryMb: number }): EffectiveLimits {
  const memory = s.limitMemoryMb === null ? defaultMemoryCap(s.memoryMb) : s.limitMemoryMb;
  const tasks = s.limitProcesses === null ? DEFAULT_TASK_LIMIT : s.limitProcesses;
  return {
    ...(memory ? { memoryMb: memory } : {}),
    ...(s.limitCpuPercent ? { cpuPercent: s.limitCpuPercent } : {}),
    ...(tasks ? { tasks } : {}),
  };
}

/** Why a memory cap cannot work with this heap, or null. */
export function memoryCapProblem(heapMb: number, capMb: number | null): string | null {
  if (!capMb) return null;
  return capMb < heapMb + MIN_MEMORY_HEADROOM_MB ? `The memory limit must be at least ${heapMb + MIN_MEMORY_HEADROOM_MB} MB: the server's ${heapMb} MB heap plus ${MIN_MEMORY_HEADROOM_MB} MB for Java itself` : null;
}
