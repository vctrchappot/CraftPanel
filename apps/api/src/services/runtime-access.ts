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
    let install: { method?: string; runtimeService?: string; dataDir?: string };
    try { install = JSON.parse((await fs.readFile(path.join(installRoot, "install.json"), "utf8")).replace(/^\uFEFF/, "")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (install.method !== "windows" || !install.runtimeService) return;
    if (!/^[\w .-]{1,100}$/.test(install.runtimeService)) throw new Error("Invalid installed runtime service name");
    const access = await agent.checkPaths(directory, javaPath);
    // Isolated servers run under restricted tokens: the runtime grants each server its folder (which
    // needs WRITE_DAC), and the token lists folders above it only where RESTRICTED (S-1-5-12) may.
    // Inside the data directory the installer and the runtime take care of that.
    const inData = (target: string) => !!install.dataDir && path.resolve(target).toLowerCase().startsWith(path.resolve(install.dataDir).toLowerCase() + path.sep);
    const isolated = agent.identity?.isolation?.method === "token";
    // java.exe needs its neighbouring DLLs/modules too. Never grant modify access to Java.
    const javaRoot = path.basename(path.dirname(javaPath)).toLowerCase() === "bin" ? path.dirname(path.dirname(javaPath)) : path.dirname(javaPath);
    const isolateDirectory = isolated && !inData(directory);
    const isolateJava = isolated && !inData(javaRoot);
    if (access.directory && access.java && !isolateDirectory && !isolateJava) return;
    const account = `NT SERVICE\\${install.runtimeService}`;
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    try {
      const parents = new Set<string>();
      for (const target of [directory, javaRoot]) {
        let parent = path.dirname(path.resolve(target));
        while (parent !== path.parse(parent).root) {
          if (!parents.has(parent)) {
            parents.add(parent);
            // Public/system ancestors may already be accessible but not writable by the
            // dashboard owner. The subsequent service probe is authoritative. Listing (RD) lets
            // Java resolve exact component names (toRealPath); it is not inherited.
            await run(executable, [parent, "/grant", `${account}:(RD,X,RA,REA,RC,S)`, ...(isolated ? ["*S-1-5-12:(RD,X,RA,S)"] : [])], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
          }
          parent = path.dirname(parent);
        }
      }
      if (!access.directory || isolateDirectory) await run(executable, [path.resolve(directory), "/grant", `${account}:(OI)(CI)(M,WDAC)`], { windowsHide: true, timeout: 10_000 });
      if (!access.java) await run(executable, [path.resolve(javaRoot), "/grant", `${account}:(OI)(CI)RX`], { windowsHide: true, timeout: 10_000 });
      // Java under Program Files is readable by Users already and not ours to change.
      if (isolateJava) await run(executable, [path.resolve(javaRoot), "/grant", "*S-1-5-12:(OI)(CI)RX"], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
      const verified = await agent.checkPaths(directory, javaPath);
      if (!verified.directory || !verified.java) throw new Error("Runtime access is still unavailable");
    } catch {
      throw new AppError(409, "runtime_path_access", "The Minecraft service could not be granted access to this server or Java installation", "Use a directory you own and a Java installation accessible to the runtime service, or have the host administrator grant the service account access.");
    }
  };
}
