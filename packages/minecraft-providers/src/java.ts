import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as tar from "tar";
import type { JavaRuntimeInfo } from "@craftpanel/shared";
import { extractZip } from "@craftpanel/backup";
import { download, fetchJson, type DownloadProgress } from "./download";

const execFileAsync = promisify(execFile);
const exe = process.platform === "win32" ? "java.exe" : "java";

export function parseJavaVersion(output: string): { version: string; major: number; vendor: string | null } | null {
  const m = /(?:openjdk|java) version "([^"]+)"/i.exec(output);
  if (!m) return null;
  const version = m[1];
  const parts = version.split(/[._-]/).map((p) => Number(p));
  const major = parts[0] === 1 ? parts[1] : parts[0];
  if (!Number.isFinite(major)) return null;
  const vendor = /Temurin/i.test(output) ? "Eclipse Temurin" : /Zulu/i.test(output) ? "Azul Zulu" : /GraalVM/i.test(output) ? "GraalVM" : /Corretto/i.test(output) ? "Amazon Corretto" : /OpenJDK/i.test(output) ? "OpenJDK" : /HotSpot/i.test(output) ? "Oracle" : null;
  return { version, major, vendor };
}

export async function inspectJava(javaPath: string): Promise<Omit<JavaRuntimeInfo, "managed"> | null> {
  try {
    // `java -version` prints to stderr.
    const { stdout, stderr } = await execFileAsync(javaPath, ["-version"], { timeout: 15000, windowsHide: true });
    const parsed = parseJavaVersion(stderr + stdout);
    return parsed ? { path: javaPath, ...parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Compatibility policy: Minecraft declares a minimum Java major. Modern
 * versions (Java 17+) run on newer Java; legacy versions (Java 8 era) often
 * break on Java 17+, so we require 8–11 for them.
 */
export function isJavaCompatible(required: number, actual: number): boolean {
  if (required <= 8) return actual >= 8 && actual <= 11;
  if (required < 17) return actual >= required && actual <= 17;
  return actual >= required;
}

async function findJavaUnder(dir: string, depth = 4): Promise<string | null> {
  const direct = path.join(dir, "bin", exe);
  try {
    await fsp.access(direct);
    return direct;
  } catch {
    /* continue */
  }
  if (depth === 0) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findJavaUnder(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

export class JavaManager {
  constructor(private readonly runtimesDir: string, private readonly tmpDir: string) {}

  /** Runtimes downloaded by CraftPanel plus JAVA_HOME and `java` on PATH. */
  async detect(): Promise<JavaRuntimeInfo[]> {
    const found = new Map<string, JavaRuntimeInfo>();
    const add = async (p: string, managed: boolean) => {
      const resolved = path.resolve(p);
      if (found.has(resolved)) return;
      const info = await inspectJava(resolved);
      if (info) found.set(resolved, { ...info, managed });
    };
    try {
      for (const d of await fsp.readdir(this.runtimesDir)) {
        const j = await findJavaUnder(path.join(this.runtimesDir, d));
        if (j) await add(j, true);
      }
    } catch {
      /* none yet */
    }
    if (process.env.JAVA_HOME) await add(path.join(process.env.JAVA_HOME, "bin", exe), false);
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, exe);
      try {
        await fsp.access(candidate);
        await add(candidate, false);
      } catch {
        /* not here */
      }
    }
    return [...found.values()].sort((a, b) => b.major - a.major);
  }

  async findCompatible(required: number): Promise<JavaRuntimeInfo | null> {
    const all = await this.detect();
    // Prefer the exact major, then managed runtimes, then the lowest compatible.
    const ok = all.filter((j) => isJavaCompatible(required, j.major));
    ok.sort((a, b) => Number(b.major === required) - Number(a.major === required) || Number(b.managed) - Number(a.managed) || a.major - b.major);
    return ok[0] ?? null;
  }

  /** Download an Eclipse Temurin JRE (or JDK fallback) from Adoptium. */
  async install(major: number, onProgress?: (stage: string, p: DownloadProgress | null) => void, signal?: AbortSignal): Promise<JavaRuntimeInfo> {
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "aarch64" : process.arch === "arm" ? "arm" : process.arch;

    type Asset = { binary: { package: { link: string; checksum: string; name: string; size: number } }; release_name: string };
    let asset: Asset | undefined;
    for (const image of ["jre", "jdk"]) {
      const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${os}&architecture=${arch}&image_type=${image}&vendor=eclipse`;
      try {
        const list = await fetchJson<Asset[]>(url, signal);
        asset = list.find((a) => /\.(zip|tar\.gz)$/.test(a.binary.package.name));
      } catch {
        asset = undefined;
      }
      if (asset) break;
    }
    if (!asset) throw new Error(`Eclipse Temurin does not provide Java ${major} for ${os}/${arch}. Install a compatible Java manually and select it in the server settings.`);

    const pkg = asset.binary.package;
    const archive = path.join(this.tmpDir, pkg.name);
    onProgress?.(`Downloading Java ${major} (${asset.release_name})`, null);
    await download({ url: pkg.link, destination: archive, checksum: { algorithm: "sha256", value: pkg.checksum }, onProgress: (p) => onProgress?.(`Downloading Java ${major}`, p), signal });

    const target = path.join(this.runtimesDir, `temurin-${major}-${asset.release_name.replace(/[^A-Za-z0-9._+-]/g, "_")}`);
    const staging = `${target}.extracting`;
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    onProgress?.(`Extracting Java ${major}`, null);
    try {
      if (pkg.name.endsWith(".zip")) await extractZip({ file: archive, destination: staging });
      else await tar.x({ file: archive, cwd: staging, preservePaths: false });
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(staging, target);
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw err;
    } finally {
      await fsp.rm(archive, { force: true });
    }
    const bin = await findJavaUnder(target);
    if (!bin) throw new Error("Java was downloaded but no java executable was found in the archive");
    const info = await inspectJava(bin);
    if (!info) throw new Error("The downloaded Java runtime failed to start on this system");
    return { ...info, managed: true };
  }
}
