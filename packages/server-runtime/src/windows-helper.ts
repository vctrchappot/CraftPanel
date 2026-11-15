import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The .NET Framework C# compiler that ships with Windows, or null. */
export function findCompiler(env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const compiler = path.join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (fs.existsSync(compiler)) return compiler;
  }
  return null;
}

/**
 * A small C# helper compiled once into the runtime directory (no native add-ons, nothing
 * downloaded). The file name carries a hash of the source, so a changed helper is rebuilt.
 */
export class CompiledHelper {
  private compiled: Promise<string> | null = null;
  private readonly hash: string;

  constructor(private directory: string, private compiler: string, private name: string, private source: string, private description: string) {
    this.hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
  }

  /** Compiled on first use, not at startup: hosts that never need it never pay for it. */
  path(): Promise<string> {
    this.compiled ??= this.compile().catch((error) => {
      this.compiled = null;
      throw error;
    });
    return this.compiled;
  }

  private async compile(): Promise<string> {
    const exe = path.join(this.directory, `${this.name}-${this.hash}.exe`);
    if (fs.existsSync(exe)) return exe;
    const temp = path.join(this.directory, `${this.name}-${this.hash}-${process.pid}`);
    try {
      await fsp.writeFile(`${temp}.cs`, this.source);
      await run(this.compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${temp}.exe`, `${temp}.cs`], { windowsHide: true, timeout: 60_000 })
        .catch((error: { stdout?: string; message: string }) => { throw new Error(`Could not compile the ${this.description}: ${(error.stdout || error.message).trim().split(/\r?\n/).pop()}`); });
      await fsp.rename(`${temp}.exe`, exe);
    } finally {
      await fsp.rm(`${temp}.cs`, { force: true });
      await fsp.rm(`${temp}.exe`, { force: true });
    }
    // Helpers of earlier versions; one still held by a running server stays until next time.
    const old = new RegExp(`^${this.name}-[0-9a-f]{12}\\.exe$`);
    for (const file of await fsp.readdir(this.directory)) {
      if (old.test(file) && file !== path.basename(exe)) await fsp.rm(path.join(this.directory, file), { force: true }).catch(() => undefined);
    }
    return exe;
  }
}
