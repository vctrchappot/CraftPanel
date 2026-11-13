import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ConsoleLine, OnlinePlayer, ServerStatus } from "@craftpanel/shared";
import { detectSignal, parseLine, parseListCount, type LogSignal } from "./log-parser";

export interface LaunchSpec {
  javaPath: string;
  directory: string;
  /** A jar, or a Java argument file ("…_args.txt", NeoForge) that names the main class and classpath. */
  jarFile: string;
  memoryMb: number;
  jvmArgs: string[];
  /** Extra arguments after the jar (e.g. "nogui"). */
  programArgs?: string[];
  /**
   * Run an executable directly instead of `java -jar`. Used for software that
   * is not a JVM jar (e.g. a future Bedrock adapter) and by tests.
   */
  command?: { file: string; args: string[] };
  /** OS limits for the whole server (Linux cgroups); absent fields are unlimited. */
  limits?: ResourceLimits;
}

export interface ResourceLimits {
  /** Hard memory cap for the process tree, swap excluded. */
  memoryMb?: number;
  /** CPU time, 100 = one core. */
  cpuPercent?: number;
  /** Processes and threads together. */
  tasks?: number;
}

/** Runs around the process: `spawned` right after spawn (sync), `exitReason` explains an unexpected exit. */
export interface LaunchHooks {
  spawned?(pid: number): void;
  exitReason?(): string | null;
  exited?(): void;
}

/** Rewrites the final command line, e.g. to run it under a game account. */
export type LaunchWrapper = (file: string, args: string[]) => { file: string; args: string[]; label?: string };

export interface ManagedServerEvents {
  status: [status: ServerStatus, detail?: string];
  lines: [lines: ConsoleLine[]];
  signal: [signal: LogSignal];
  players: [players: OnlinePlayer[]];
  exit: [info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean; restart: boolean }];
}

interface PendingQuery {
  match: (message: string) => RegExpExecArray | null;
  resolve: (m: RegExpExecArray | null) => void;
  /** Consumes matching lines and any lines that `swallow` accepts until resolved. */
  swallow?: (message: string) => boolean;
  timer: NodeJS.Timeout;
}

const RING_SIZE = 2000;

/**
 * One Minecraft server process. Owns the child process, its stdin, a ring
 * buffer of console output and the lifecycle state machine:
 *
 *   stopped → starting → running → stopping → stopped
 *                 ↘ crashed / error (unexpected exit or spawn failure)
 */
export class ManagedServer extends EventEmitter<ManagedServerEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private _status: ServerStatus = "stopped";
  private seq = 0;
  private ring: ConsoleLine[] = [];
  private ringBytes = 0;
  private pendingLines: ConsoleLine[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  /** `restart` was typed in the console: the process is meant to stop and be started again. */
  private restartRequested = false;
  private killRequested = false;
  private queries: PendingQuery[] = [];
  private _players = new Map<string, OnlinePlayer>();
  private recentErrors: string[] = [];
  /** Mods NeoForge reported as failed during this start (id → jar file), and whether one touched client-only code. */
  private failedMods = new Map<string, string | null>();
  private clientOnlyMod = false;
  startedAt: number | null = null;
  readyAt: number | null = null;
  lastExitCode: number | null = null;
  lastError: string | null = null;
  maxPlayers: number | null = null;

  constructor(public readonly id: string) {
    super();
  }

  get status(): ServerStatus {
    return this._status;
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  get players(): OnlinePlayer[] {
    return [...this._players.values()];
  }
  get isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }
  history(limit = RING_SIZE): ConsoleLine[] {
    return this.ring.slice(-limit);
  }

  setStatus(status: ServerStatus, detail?: string) {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status, detail);
  }

  start(spec: LaunchSpec, wrap?: LaunchWrapper, hooks: LaunchHooks = {}): void {
    if (this.isAlive) throw new Error("Server process is already running");
    this.stopRequested = false;
    this.restartRequested = false;
    this.killRequested = false;
    this.recentErrors = [];
    this.lastError = null;
    this.failedMods.clear();
    this.clientOnlyMod = false;
    this._players.clear();
    this.emit("players", []);

    const file = spec.command?.file ?? spec.javaPath;
    const args = spec.command?.args ?? [
      `-Xms${Math.min(spec.memoryMb, Math.max(512, Math.floor(spec.memoryMb / 2)))}M`,
      `-Xmx${spec.memoryMb}M`,
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      "-Dterminal.jline=false",
      "-Dterminal.ansi=false",
      ...spec.jvmArgs,
      ...launchTarget(spec.jarFile),
      ...(spec.programArgs ?? ["nogui"]),
    ];

    this.setStatus("starting");
    const launch = wrap ? wrap(file, args) : { file, args };
    this.system(`Starting: ${file} ${args.join(" ")}${launch.label ? ` (${launch.label})` : ""}`);
    // Spawned directly (no shell) so nothing in the arguments is interpreted.
    const child = spawn(launch.file, launch.args, {
      cwd: spec.directory,
      stdio: "pipe",
      windowsHide: true,
      shell: false,
      env: { ...process.env, JAVA_TOOL_OPTIONS: undefined } as NodeJS.ProcessEnv,
    });
    this.child = child;
    if (child.pid) hooks.spawned?.(child.pid);
    this.startedAt = Date.now();
    this.readyAt = null;

    this.pipe(child.stdout, "stdout");
    this.pipe(child.stderr, "stderr");

    child.on("error", (err) => {
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? `Executable not found: ${file}` : `Failed to start process: ${err.message}`;
      this.lastError = msg;
      this.system(msg, "ERROR");
      this.child = null;
      this.startedAt = null;
      hooks.exited?.();
      this.setStatus("error", msg);
    });

    child.on("exit", (code, signal) => {
      this.flush();
      // A clean exit (code 0) after the server was up is a shutdown too: /stop typed in game, by a plugin or script.
      const expected = this.stopRequested || this.killRequested || (code === 0 && this.readyAt !== null);
      const restart = this.restartRequested && !this.killRequested;
      this.lastExitCode = code;
      this.child = null;
      this.startedAt = null;
      this.readyAt = null;
      for (const q of this.queries.splice(0)) {
        clearTimeout(q.timer);
        q.resolve(null);
      }
      if (this._players.size) {
        this._players.clear();
        this.emit("players", []);
      }
      if (expected) {
        this.system(this.killRequested ? "Process was force-terminated." : `Server stopped (exit code ${code ?? signal}).`);
        this.setStatus("stopped");
      } else {
        const exit = `Process exited unexpectedly (${code !== null ? `exit code ${code}` : `signal ${signal}`})`;
        const lastLogError = this.recentErrors.slice(-1)[0];
        const reason = this.lastError ?? hooks.exitReason?.() ?? this.modFailure() ?? (lastLogError ? `${exit}. Last error: ${lastLogError}` : exit);
        this.lastError = reason;
        this.system(`Server crashed: ${reason}`, "ERROR");
        this.setStatus("crashed", reason);
      }
      hooks.exited?.();
      this.emit("exit", { code, signal, expected, restart });
    });
  }

  private pipe(stream: NodeJS.ReadableStream, name: "stdout" | "stderr") {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    stream.on("data", (chunk: Buffer) => {
      partial += decoder.write(chunk);
      let idx;
      while ((idx = partial.indexOf("\n")) >= 0) {
        const raw = partial.slice(0, idx).replace(/\r$/, "");
        partial = partial.slice(idx + 1);
        this.handleLine(raw, name);
      }
      // Guard against unbounded partial lines.
      if (partial.length > 64 * 1024) {
        this.handleLine(partial, name);
        partial = "";
      }
    });
    stream.on("end", () => {
      partial += decoder.end();
      if (partial) this.handleLine(partial, name);
    });
  }

  private handleLine(raw: string, stream: "stdout" | "stderr") {
    const parsed = parseLine(raw);
    // JVM warnings on stderr ("WARNING: ...") are not errors.
    const level = stream === "stderr" && parsed.level === "UNKNOWN" ? (/^WARNING:/.test(parsed.message) ? "WARN" : "ERROR") : parsed.level;

    // Internal queries (TPS, gamerules, list) consume their response lines.
    let internal = false;
    for (let i = 0; i < this.queries.length; i++) {
      const q = this.queries[i];
      const m = q.match(parsed.message);
      if (m) {
        clearTimeout(q.timer);
        this.queries.splice(i, 1);
        q.resolve(m);
        internal = true;
        break;
      }
      if (q.swallow?.(parsed.message)) {
        internal = true;
        break;
      }
    }

    if (level === "ERROR" || level === "FATAL") {
      this.recentErrors.push(parsed.message.slice(0, 500));
      if (this.recentErrors.length > 20) this.recentErrors.shift();
    }

    const signal = detectSignal(parsed.message);
    if (signal) this.onSignal(signal);
    const list = parseListCount(parsed.message);
    if (list) this.maxPlayers = list.max;

    if (!internal) this.push({ stream, level, text: stripTrailing(raw) });
  }

  private onSignal(signal: LogSignal) {
    switch (signal.kind) {
      case "done":
        this.readyAt = Date.now();
        if (this._status === "starting") this.setStatus("running");
        break;
      case "join":
        this._players.set(signal.name, { name: signal.name, uuid: this.pendingUuids.get(signal.name) ?? null, joinedAt: Date.now() });
        this.emit("players", this.players);
        break;
      case "leave":
        if (this._players.delete(signal.name)) this.emit("players", this.players);
        break;
      case "uuid":
        this.pendingUuids.set(signal.name, signal.uuid);
        if (this.pendingUuids.size > 200) this.pendingUuids.delete(this.pendingUuids.keys().next().value!);
        break;
      case "port-in-use":
        this.lastError = "The server port is already in use by another program. Change the port on the Network page or stop the other program.";
        break;
      case "eula":
        this.lastError = "The Minecraft EULA has not been accepted.";
        break;
      case "stopping":
        if (this._status === "running" || this._status === "starting") this.setStatus("stopping");
        break;
      case "mod-failed":
        if (!this.failedMods.has(signal.mod)) this.failedMods.set(signal.mod, null);
        break;
      case "mod-file": {
        // The file follows its "Mod loading issue for" block.
        const last = [...this.failedMods.keys()].at(-1);
        if (last && !this.failedMods.get(last)) this.failedMods.set(last, signal.file);
        break;
      }
      case "client-only":
        if (this.failedMods.size) this.clientOnlyMod = true;
        break;
    }
    this.emit("signal", signal);
  }
  private pendingUuids = new Map<string, string>();

  /** "Mod loading failed: …" with the files to disable, when NeoForge reported failed mods. */
  private modFailure(): string | null {
    if (!this.failedMods.size) return null;
    const names = [...this.failedMods].map(([id, file]) => file ?? id).join(", ");
    const why = this.clientOnlyMod ? " It uses client-only code (a client mod that can't run on a server)." : "";
    return `Mod loading failed: ${names}.${why} Disable ${this.failedMods.size === 1 ? "it" : "them"} on the Mods tab and start again.`;
  }

  private push(line: Omit<ConsoleLine, "seq" | "ts">) {
    line = { ...line, text: line.text.slice(0, 16_384) };
    const full: ConsoleLine = { ...line, seq: ++this.seq, ts: Date.now() };
    this.ring.push(full);
    this.ringBytes += Buffer.byteLength(JSON.stringify(full));
    while (this.ring.length > RING_SIZE || this.ringBytes > 512 * 1024) this.ringBytes -= Buffer.byteLength(JSON.stringify(this.ring.shift()!));
    this.pendingLines.push(full);
    // Flush before a burst can exceed the transport frame budget.
    if (this.pendingLines.length >= 32) this.flush();
    // Batch lines to avoid flooding WebSocket clients during startup.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 50);
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pendingLines.length) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.emit("lines", lines);
  }

  system(text: string, level: ConsoleLine["level"] = "INFO") {
    this.push({ stream: "system", level, text });
  }

  /** Write a command to the server's stdin. */
  send(command: string, echo = true): void {
    if (!this.isAlive || !this.child) throw new Error("Server is not running");
    if (/[\r\n\0]/.test(command)) throw new Error("Commands must be a single line");
    const cmd = command.replace(/^\//, "");
    // `stop` and `restart` typed in the console end the process on purpose; without this the exit would read as a crash.
    const word = cmd.trim().split(/\s+/)[0];
    if ((word === "stop" || word === "restart") && !this.stopRequested) {
      this.stopRequested = true;
      this.restartRequested = word === "restart";
      this.setStatus("stopping");
    }
    if (echo) this.push({ stream: "command", level: "INFO", text: `> ${cmd}` });
    this.child.stdin.write(cmd + "\n");
  }

  /**
   * Send a command and wait for a response line matching `pattern`. The
   * matching line is not shown in the console.
   */
  query(command: string, pattern: RegExp, opts: { timeoutMs?: number; swallow?: RegExp } = {}): Promise<RegExpExecArray | null> {
    if (!this.isAlive) return Promise.resolve(null);
    return new Promise((resolve) => {
      const q: PendingQuery = {
        match: (msg) => pattern.exec(msg),
        swallow: opts.swallow ? (msg) => opts.swallow!.test(msg) : undefined,
        resolve,
        timer: setTimeout(() => {
          const i = this.queries.indexOf(q);
          if (i >= 0) this.queries.splice(i, 1);
          resolve(null);
        }, opts.timeoutMs ?? 3000),
      };
      this.queries.push(q);
      try {
        this.send(command, false);
      } catch {
        clearTimeout(q.timer);
        this.queries.splice(this.queries.indexOf(q), 1);
        resolve(null);
      }
    });
  }

  /**
   * Graceful stop via the `stop` command. Resolves when the process exits
   * or after the timeout (the process is left running; killing requires an
   * explicit `kill()` call).
   */
  async stop(timeoutMs = 90_000): Promise<boolean> {
    if (!this.isAlive || !this.child) return true;
    this.stopRequested = true;
    this.setStatus("stopping");
    const child = this.child;
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      this.send("stop");
    } catch {
      /* stdin closed */
    }
    const ok = await exited;
    if (!ok) this.system(`Server did not stop within ${Math.round(timeoutMs / 1000)}s. Use "Kill" to force termination.`, "WARN");
    return ok;
  }

  /** Force termination. Only used on explicit user request. */
  kill(): void {
    if (!this.child) return;
    this.killRequested = true;
    this.system("Force-terminating process…", "WARN");
    this.child.kill("SIGKILL");
  }

  waitForExit(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => this.child!.once("exit", () => resolve()));
  }

  clearRing() {
    this.ring = [];
    this.ringBytes = 0;
  }
}

function stripTrailing(s: string): string {
  return s.replace(/\s+$/, "");
}

/** `-jar file`, or `@file` for an argument file (NeoForge writes unix_args.txt and win_args.txt; pick this OS's). */
export function launchTarget(jarFile: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!jarFile.endsWith("_args.txt")) return ["-jar", jarFile];
  return ["@" + localArgsFile(jarFile, platform)];
}

export function localArgsFile(file: string, platform: NodeJS.Platform = process.platform): string {
  return file.replace(/(unix|win)_args[.]txt$/, platform === "win32" ? "win_args.txt" : "unix_args.txt");
}
