import fs from "node:fs/promises";
import os from "node:os";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort executable name for a PID (used to confirm a stored PID is still Java). */
export async function processName(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
      const m = /^"([^"]+)","(\d+)"/m.exec(stdout.trim());
      return m && Number(m[2]) === pid ? m[1] : null;
    }
    if (process.platform === "linux") return (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim();
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isJavaProcess(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  const name = await processName(pid);
  return !!name && /java/i.test(name);
}

export interface ProcessSample {
  cpuPercent: number | null;
  memoryBytes: number | null;
}

/** Samples CPU (normalized to one core = 100%) and resident memory for PIDs. */
export interface ProcessProbe {
  sample(pid: number): Promise<ProcessSample>;
  dispose(): void;
}

class LinuxProbe implements ProcessProbe {
  private last = new Map<number, { ticks: number; at: number }>();
  private readonly hz = 100;
  private readonly pageSize = 4096;
  async sample(pid: number): Promise<ProcessSample> {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      const rssPages = Number(fields[21]);
      const now = Date.now();
      const prev = this.last.get(pid);
      this.last.set(pid, { ticks, at: now });
      const cpu = prev ? ((ticks - prev.ticks) / this.hz / ((now - prev.at) / 1000)) * 100 : null;
      return { cpuPercent: cpu, memoryBytes: rssPages * this.pageSize };
    } catch {
      return { cpuPercent: null, memoryBytes: null };
    }
  }
  dispose() {}
}

class PsProbe implements ProcessProbe {
  async sample(pid: number): Promise<ProcessSample> {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)]);
      const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
      return { cpuPercent: Number.isFinite(cpu) ? cpu : null, memoryBytes: Number.isFinite(rss) ? rss * 1024 : null };
    } catch {
      return { cpuPercent: null, memoryBytes: null };
    }
  }
  dispose() {}
}

/**
 * Windows has no cheap per-process API reachable from Node without native
 * add-ons, so we keep one long-lived PowerShell process and query it.
 */
class WindowsProbe implements ProcessProbe {
  private ps: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private waiters: ((line: string) => void)[] = [];
  private last = new Map<number, { cpuMs: number; at: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.ps && this.ps.exitCode === null) return this.ps;
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"], { windowsHide: true, stdio: "pipe" });
    ps.stdout.setEncoding("utf8");
    ps.stdout.on("data", (d: string) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line.startsWith("CPSAMPLE")) this.waiters.shift()?.(line);
      }
    });
    ps.on("exit", () => {
      for (const w of this.waiters.splice(0)) w("CPSAMPLE ERR");
      this.ps = null;
    });
    ps.on("error", () => {});
    this.ps = ps;
    return ps;
  }

  sample(pid: number): Promise<ProcessSample> {
    const run = async (): Promise<ProcessSample> => {
      const ps = this.ensure();
      const line = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("CPSAMPLE ERR"), 5000);
        this.waiters.push((l) => {
          clearTimeout(timer);
          resolve(l);
        });
        ps.stdin.write(
          `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ("CPSAMPLE " + [int64]$p.TotalProcessorTime.TotalMilliseconds + " " + $p.WorkingSet64) } catch { Write-Output "CPSAMPLE ERR" }\n`,
        );
      });
      const m = /^CPSAMPLE (\d+) (\d+)$/.exec(line);
      if (!m) return { cpuPercent: null, memoryBytes: null };
      const cpuMs = Number(m[1]);
      const now = Date.now();
      const prev = this.last.get(pid);
      this.last.set(pid, { cpuMs, at: now });
      const cpu = prev && now > prev.at ? ((cpuMs - prev.cpuMs) / (now - prev.at)) * 100 : null;
      return { cpuPercent: cpu, memoryBytes: Number(m[2]) };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  dispose() {
    this.ps?.kill();
    this.ps = null;
  }
}

export function createProcessProbe(): ProcessProbe {
  if (process.platform === "win32") return new WindowsProbe();
  if (process.platform === "linux") return new LinuxProbe();
  return new PsProbe();
}

export function systemMemory() {
  return { total: os.totalmem(), free: os.freemem() };
}
