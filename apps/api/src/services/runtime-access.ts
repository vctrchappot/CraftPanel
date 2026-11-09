import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "@craftpanel/shared";
import type { RuntimeAgent } from "@craftpanel/server-runtime";

const run = promisify(execFile);

/** The dashboard owner can grant its service access to newly chosen storage/Java paths. */
export function runtimeAccess(installRoot: string | undefined, agent: RuntimeAgent) {
  return async (directory: string, javaPath: string) => {
    if (process.platform !== "win32" || !installRoot) return;
    let install: { method?: string; runtimeService?: string };
    try { install = JSON.parse((await fs.readFile(path.join(installRoot, "install.json"), "utf8")).replace(/^\uFEFF/, "")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (install.method !== "windows" || !install.runtimeService) return;
    if (!/^[\w .-]{1,100}$/.test(install.runtimeService)) throw new Error("Invalid installed runtime service name");
    const access = await agent.checkPaths(directory, javaPath);
    if (access.directory && access.java) return;
    const account = `NT SERVICE\\${install.runtimeService}`;
    // java.exe needs its neighbouring DLLs/modules too. Never grant modify access to Java.
    const javaRoot = path.basename(path.dirname(javaPath)).toLowerCase() === "bin" ? path.dirname(path.dirname(javaPath)) : path.dirname(javaPath);
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    try {
      if (!access.directory) await run(executable, [path.resolve(directory), "/grant", `${account}:(OI)(CI)M`], { windowsHide: true, timeout: 10_000 });
      if (!access.java) await run(executable, [path.resolve(javaRoot), "/grant", `${account}:(OI)(CI)RX`], { windowsHide: true, timeout: 10_000 });
      const verified = await agent.checkPaths(directory, javaPath);
      if (!verified.directory || !verified.java) throw new Error("Runtime access is still unavailable");
    } catch {
      throw new AppError(409, "runtime_path_access", "The Minecraft service could not be granted access to this server or Java installation", "Use a directory you own and a Java installation accessible to the runtime service, or have the host administrator grant the service account access.");
    }
  };
}
