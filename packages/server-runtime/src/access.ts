import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export interface RuntimePathAccess { directory: boolean; java: boolean }

/** Probe with the process owner's actual identity, not the dashboard user's permissions. */
export async function checkRuntimePaths(directory: string, javaPath: string): Promise<RuntimePathAccess> {
  const probe = path.join(directory, `.craftpanel-access-${crypto.randomUUID()}`);
  let writable = false;
  try {
    const handle = await fs.open(probe, "wx", 0o600);
    await handle.close();
    await fs.unlink(probe);
    writable = true;
  } catch { /* The dashboard may grant the service access and retry. */ }
  // Java's toRealPath (used by Paperclip) looks up each component's exact name on Windows,
  // which needs listing access to every ancestor, not just traversal.
  if (writable && process.platform === "win32") {
    for (let parent = path.dirname(path.resolve(directory)); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      try { await (await fs.opendir(parent)).close(); } catch { writable = false; break; }
    }
  }
  let java = false;
  try { await run(javaPath, ["-version"], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }); java = true; }
  catch { /* Java needs executable, DLL and module access under the service account. */ }
  return { directory: writable, java };
}
