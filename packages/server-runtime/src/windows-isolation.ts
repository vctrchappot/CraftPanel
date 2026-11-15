import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CompiledHelper } from "./windows-helper";
import { TOKEN_HELPER_SOURCE } from "./windows-token-helper";

const run = promisify(execFile);

/**
 * A SID of its own per server, under the resource manager authority (S-1-9) that Windows leaves
 * to applications. It names no account; it only appears in the server's restricted token and on
 * its folders. Derived from the server id, so it stays the same across runtime restarts.
 */
export function serverSid(id: string): string {
  const hash = crypto.createHash("sha256").update(`craftpanel-server:${id}`).digest();
  return `S-1-9-${[0, 4, 8, 12, 16].map((offset) => hash.readUInt32LE(offset)).join("-")}`;
}

/** The SID of the account this process runs as; virtual service accounts are S-1-5-80-…. */
export async function currentUserSid(): Promise<string | null> {
  try {
    const whoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
    const { stdout } = await run(whoami, ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10_000 });
    return /"(S-1-[\d-]+)"/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The folder a Java executable belongs to: the installation for `...\bin\java.exe`. */
export function programRoot(file: string): string {
  const dir = path.dirname(path.resolve(file));
  return path.basename(dir).toLowerCase() === "bin" ? path.dirname(dir) : dir;
}

export interface Preparation { problems: string[]; warnings: string[] }

/**
 * Per-server isolation on Windows: every server runs under a restricted copy of the runtime's
 * token with its own SID. See `windows-token-helper.ts` for what the token can reach.
 */
export class WindowsIsolation {
  private helper: CompiledHelper;

  constructor(directory: string, compiler: string, private dataDir: string) {
    this.helper = new CompiledHelper(directory, compiler, "server-token", TOKEN_HELPER_SOURCE, "restricted token helper");
  }

  /** Each server's temp folder, emptied before every start. */
  tempDir(id: string) {
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid server id");
    return path.join(this.dataDir, "game-temp", id);
  }

  /** Grants the server its folders and checks under its token what it can reach. */
  async prepare(id: string, directory: string, file: string): Promise<Preparation> {
    const temp = this.tempDir(id);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    await fs.mkdir(temp, { recursive: true });
    const exe = await this.helper.path();
    const { stdout } = await run(exe, ["prepare", serverSid(id), this.dataDir, directory, temp, file, programRoot(file)], { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 });
    const lines = stdout.split(/\r?\n/);
    if (!lines.includes("ok")) throw new Error("The restricted token helper gave no result");
    return {
      problems: lines.filter((l) => l.startsWith("problem ")).map((l) => l.slice(8)),
      warnings: lines.filter((l) => l.startsWith("warn ")).map((l) => l.slice(5)),
    };
  }

  /** The command line that starts `file args` under the server's token. The helper reports the game's PID first. */
  async wrap(id: string): Promise<(file: string, args: string[]) => { file: string; args: string[]; label: string; reportsPid: true }> {
    const exe = await this.helper.path();
    const sid = serverSid(id);
    const temp = this.tempDir(id);
    return (file, args) => ({ file: exe, args: ["run", sid, temp, "--", file, ...args], label: "restricted token", reportsPid: true });
  }

  async forget(id: string) {
    try { await fs.rm(this.tempDir(id), { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ }
  }
}
