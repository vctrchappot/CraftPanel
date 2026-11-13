import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { LaunchHooks, ResourceLimits } from "./managed-server";
import { memoryLimitReason, type LimitSupport, type Limiter } from "./limiter";

/**
 * Per-server resource limits through a delegated cgroup v2 subtree (`Delegate=yes` on the
 * runtime unit). The runtime moves itself into `runtime/`, enables the controllers for its
 * children and puts every server into `server-<id>/` right after spawning it. Limits can be
 * changed while the server runs. https://docs.kernel.org/admin-guide/cgroup-v2.html
 */
type Controller = "memory" | "cpu" | "pids";
const WANTED: Controller[] = ["memory", "cpu", "pids"];
const PERIOD_US = 100_000;

export class Cgroups implements Limiter {
  private constructor(private root: string | null, readonly support: LimitSupport) {}

  static unavailable(reason: string) { return new Cgroups(null, { available: false, reason }); }

  static async detect(env: NodeJS.ProcessEnv = process.env): Promise<Cgroups> {
    if (process.platform !== "linux") return Cgroups.unavailable("Resource limits need Linux cgroups or Windows job objects");
    if (env.CRAFTPANEL_LIMITS === "off") return Cgroups.unavailable("Disabled by CRAFTPANEL_LIMITS=off");
    const own = /^0::(\/.*)$/m.exec(await fsp.readFile("/proc/self/cgroup", "utf8").catch(() => ""))?.[1];
    if (!own) return Cgroups.unavailable("This host does not use cgroup v2");
    // Already moved into our leaf by an earlier detect (tests) or a previous runtime generation.
    const root = path.join("/sys/fs/cgroup", path.basename(own) === "runtime" ? path.dirname(own) : own);
    try { await fsp.access(path.join(root, "cgroup.subtree_control"), fs.constants.W_OK); }
    catch { return Cgroups.unavailable("The runtime service has no delegated cgroup (Delegate=yes); install CraftPanel as a Linux service"); }
    const available = (await fsp.readFile(path.join(root, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
    const controllers = WANTED.filter((c) => available.includes(c));
    if (!controllers.length) return Cgroups.unavailable("The kernel offers no memory, cpu or pids controller to this service");
    try {
      // No process may stay in a cgroup that hands controllers to its children.
      await fsp.mkdir(path.join(root, "runtime"), { recursive: true });
      for (const pid of (await fsp.readFile(path.join(root, "cgroup.procs"), "utf8")).split("\n").filter(Boolean)) {
        await fsp.writeFile(path.join(root, "runtime", "cgroup.procs"), pid).catch(() => undefined);
      }
      await fsp.writeFile(path.join(root, "cgroup.subtree_control"), controllers.map((c) => `+${c}`).join(" "));
    } catch (error) {
      return Cgroups.unavailable(`Could not set up the runtime's cgroup: ${(error as Error).message}`);
    }
    const missing = WANTED.filter((c) => !controllers.includes(c));
    return new Cgroups(root, { available: true, controllers, ...(missing.length ? { reason: `The kernel does not offer: ${missing.join(", ")} (on a Raspberry Pi, add cgroup_enable=memory to cmdline.txt)` } : {}) });
  }

  private dir(id: string) { return path.join(this.root!, `server-${id}`); }

  /** Writes limits into an existing server cgroup. Unsupported controllers are skipped. */
  private writeLimits(dir: string, limits: ResourceLimits) {
    const has = (c: Controller) => this.support.controllers?.includes(c);
    if (has("memory")) {
      fs.writeFileSync(path.join(dir, "memory.max"), limits.memoryMb ? String(limits.memoryMb * 1024 * 1024) : "max");
      // A cap that spills into swap only makes the game crawl; the cap must be real.
      fs.writeFileSync(path.join(dir, "memory.swap.max"), limits.memoryMb ? "0" : "max");
    }
    if (has("cpu")) fs.writeFileSync(path.join(dir, "cpu.max"), limits.cpuPercent ? `${Math.round(limits.cpuPercent / 100 * PERIOD_US)} ${PERIOD_US}` : `max ${PERIOD_US}`);
    if (has("pids")) fs.writeFileSync(path.join(dir, "pids.max"), limits.tasks ? String(limits.tasks) : "max");
  }

  /** Hooks for one server run: join the cgroup on spawn, explain an OOM kill, clean up on exit. `current` reads limits changed since. */
  hooks(id: string, current: () => ResourceLimits, onError: (error: Error) => void): LaunchHooks {
    if (!this.root) return {};
    const dir = this.dir(id);
    let done = false;
    return {
      spawned: (pid) => {
        try {
          this.remove(dir);
          fs.mkdirSync(dir);
          this.writeLimits(dir, current());
          // Moves every thread of the process; the JVM has not forked anything yet.
          fs.writeFileSync(path.join(dir, "cgroup.procs"), String(pid));
        } catch (error) {
          onError(error as Error);
        }
      },
      exitReason: () => {
        try {
          const oom = /^oom_kill (\d+)$/m.exec(fs.readFileSync(path.join(dir, "memory.events"), "utf8"))?.[1];
          if (oom && Number(oom) > 0) return memoryLimitReason(current().memoryMb, "the system stopped the server");
        } catch { /* no memory controller */ }
        return null;
      },
      exited: () => {
        if (done) return;
        done = true;
        // Leftovers a plugin forked off die with the server; the directory goes once it is empty.
        try { fs.writeFileSync(path.join(dir, "cgroup.kill"), "1"); } catch { /* kernel < 5.14 */ }
        void this.removeLater(dir);
      },
    };
  }

  /** Changes the limits of a running server. Returns false when it has no cgroup. */
  update(id: string, limits: ResourceLimits): boolean {
    if (!this.root || !fs.existsSync(this.dir(id))) return false;
    this.writeLimits(this.dir(id), limits);
    return true;
  }

  /** Current usage of a server's cgroup, for diagnostics and tests. */
  usage(id: string): { memoryBytes: number | null; tasks: number | null } | null {
    if (!this.root || !fs.existsSync(this.dir(id))) return null;
    const read = (file: string) => { try { return Number(fs.readFileSync(path.join(this.dir(id), file), "utf8").trim()); } catch { return null; } };
    return { memoryBytes: read("memory.current"), tasks: read("pids.current") };
  }

  private remove(dir: string) {
    try { fs.rmdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async removeLater(dir: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await fsp.rmdir(dir); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
