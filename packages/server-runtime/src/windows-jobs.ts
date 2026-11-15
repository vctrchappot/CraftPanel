import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { LaunchHooks, ResourceLimits } from "./managed-server";
import { memoryLimitReason, type LimitSupport, type Limiter } from "./limiter";
import { JOB_HELPER_SOURCE } from "./windows-job-helper";
import { CompiledHelper, findCompiler } from "./windows-helper";

/**
 * Per-server resource limits on Windows: a small helper, compiled once into the runtime
 * directory, puts each server process into its own job object right after it is spawned
 * and keeps it for live changes. The job nests inside the runtime's own jobs, so stopping
 * the runtime still stops everything. https://learn.microsoft.com/windows/win32/procthread/job-objects
 */
export class WindowsJobs implements Limiter {
  private helpers = new Map<string, ChildProcessWithoutNullStreams>();
  private helper: CompiledHelper;

  private constructor(directory: string, compiler: string, readonly support: LimitSupport) {
    this.helper = new CompiledHelper(directory, compiler, "job-helper", JOB_HELPER_SOURCE, "job object helper");
  }

  static async detect(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<Limiter> {
    const compiler = findCompiler(env);
    if (compiler) return new WindowsJobs(directory, compiler, { available: true, controllers: ["memory", "cpu", "processes"] });
    return { support: { available: false, reason: "The .NET Framework C# compiler (csc.exe) that builds the job object helper is missing" }, hooks: () => ({}), update: () => false };
  }

  hooks(id: string, current: () => ResourceLimits, onError: (error: Error) => void, notice: (message: string) => void = () => undefined): LaunchHooks {
    let child: ChildProcessWithoutNullStreams | null = null;
    let memoryHit = false;
    let processHit = false;
    let done = false;
    return {
      spawned: (pid) => {
        this.helper.path().then((exe) => {
          if (done) return;
          // Limits changed while compiling are read here, not at spawn.
          child = spawn(exe, [String(pid), ...args(current())], { stdio: "pipe", windowsHide: true });
          this.helpers.set(id, child);
          child.on("error", onError);
          child.stdin.on("error", () => undefined);
          readline.createInterface({ input: child.stdout }).on("line", (line) => {
            // Java may survive a failed allocation and only slow down, so say it while it runs; once per run.
            if (line === "memory-limit" && !memoryHit) {
              memoryHit = true;
              notice(memoryLimitReason(current().memoryMb, "Java could not get more memory, so the server may slow down or stop"));
            } else if (line === "process-limit" && !processHit) {
              processHit = true;
              notice(`Process limit reached (${current().tasks}): a new process could not start. Raise the limit in the Performance tab.`);
            } else if (line.startsWith("error ")) onError(new Error(line.slice(6)));
          });
        }).catch(onError);
      },
      exitReason: () => (memoryHit ? memoryLimitReason(current().memoryMb, "Java could not get more memory and stopped") : null),
      exited: () => {
        if (done) return;
        done = true;
        if (!child) return;
        if (this.helpers.get(id) === child) this.helpers.delete(id);
        // Leftovers a plugin started die with the server; then the helper ends with its input.
        child.stdin.end("kill\n");
        const helper = child;
        setTimeout(() => { if (helper.exitCode === null) helper.kill(); }, 5000).unref();
      },
    };
  }

  update(id: string, limits: ResourceLimits): boolean {
    const child = this.helpers.get(id);
    if (!child || child.stdin.writableEnded) return false;
    child.stdin.write(`limits ${args(limits).join(" ")}\n`);
    return true;
  }
}

const args = (limits: ResourceLimits) => [limits.memoryMb ?? 0, limits.cpuPercent ?? 0, limits.tasks ?? 0].map((n) => String(Math.max(0, Math.floor(n))));
