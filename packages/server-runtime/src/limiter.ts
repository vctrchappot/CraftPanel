import type { LaunchHooks, ResourceLimits } from "./managed-server";
import { Cgroups } from "./cgroups";
import { WindowsJobs } from "./windows-jobs";

/** What the host can enforce; `controllers` names the kinds of limits that apply. */
export interface LimitSupport { available: boolean; reason?: string; controllers?: string[] }

/** Applies per-server resource limits: Linux cgroups or Windows job objects. */
export interface Limiter {
  readonly support: LimitSupport;
  /** Hooks for one server run. `current` reads limits changed since the start; `notice` explains a limit the server ran into. */
  hooks(id: string, current: () => ResourceLimits, onError: (error: Error) => void, notice?: (message: string) => void): LaunchHooks;
  /** Changes the limits of a running server. Returns false when it has none applied. */
  update(id: string, limits: ResourceLimits): boolean;
}

export function unavailableLimiter(reason: string): Limiter {
  return { support: { available: false, reason }, hooks: () => ({}), update: () => false };
}

/** `directory` is the runtime's private directory, where Windows keeps its compiled helper. */
export async function detectLimiter(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<Limiter> {
  if (env.CRAFTPANEL_LIMITS === "off") return unavailableLimiter("Disabled by CRAFTPANEL_LIMITS=off");
  if (process.platform === "linux") return Cgroups.detect(env);
  if (process.platform === "win32") return WindowsJobs.detect(directory, env);
  return unavailableLimiter("Resource limits need Linux cgroups or Windows job objects");
}

export const memoryLimitReason = (memoryMb: number | undefined, how: string) =>
  `Memory limit reached (${memoryMb} MB): ${how}. Raise the limit or lower the memory in the Performance tab.`;
