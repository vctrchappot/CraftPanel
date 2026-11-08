import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { download, fetchJson, TtlCache, USER_AGENT, assertTrustedUrl, fetchWithRetry } from "./download";

const MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const VERSIONS = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const SAFE = /^[0-9]+(\.[0-9]+){2,3}(-beta)?$/;

const versionCache = new TtlCache<string[]>(10 * 60 * 1000);

/** Every published NeoForge version, oldest first (as Maven lists them). */
export function listNeoForgeVersions(): Promise<string[]> {
  return versionCache.get("all", async () => (await fetchJson<{ versions: string[] }>(VERSIONS)).versions.filter((v) => SAFE.test(v)));
}

/**
 * The Minecraft version a NeoForge version targets. Up to 1.21.x NeoForge drops the leading "1."
 * (21.1.172 → 1.21.1, 21.0.x → 1.21); from 26.x it repeats the full game version plus a build
 * (26.1.2.126 → 26.1.2, 26.3.0.101 → 26.3).
 */
export function neoForgeMinecraftVersion(version: string): string | null {
  if (!SAFE.test(version)) return null;
  const parts = version.replace(/-beta$/, "").split(".").map(Number);
  if (parts.length === 4) return parts[2] === 0 ? `${parts[0]}.${parts[1]}` : `${parts[0]}.${parts[1]}.${parts[2]}`;
  const [major, minor] = parts;
  if (major >= 26) return null;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

export const isNeoForgeStable = (version: string) => !version.endsWith("-beta");

/** NeoForge versions for one Minecraft version, newest first. */
export async function neoForgeBuilds(mcVersion: string): Promise<{ version: string; stable: boolean }[]> {
  return (await listNeoForgeVersions())
    .filter((v) => neoForgeMinecraftVersion(v) === mcVersion)
    .map((v) => ({ version: v, stable: isNeoForgeStable(v) }))
    .sort((a, b) => compareNeoForge(b.version, a.version));
}

function compareNeoForge(a: string, b: string): number {
  const pa = a.replace(/-beta$/, "").split(".").map(Number);
  const pb = b.replace(/-beta$/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Minecraft versions with at least one stable NeoForge release, newest first. */
export async function neoForgeGameVersions(): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const v of await listNeoForgeVersions()) {
    const mc = neoForgeMinecraftVersion(v);
    if (!mc || !isNeoForgeStable(v)) continue;
    const prev = seen.get(mc);
    if (!prev || compareNeoForge(v, prev) > 0) seen.set(mc, v);
  }
  return [...seen.entries()].sort((a, b) => compareNeoForge(b[1], a[1])).map(([mc]) => mc);
}

/** The requested NeoForge version, or the newest stable one (newest beta when there is none) for this Minecraft version. */
export async function resolveNeoForge(mcVersion: string, requested?: string | null): Promise<string> {
  const builds = await neoForgeBuilds(mcVersion);
  if (requested) {
    if (!builds.some((b) => b.version === requested)) throw new Error(`NeoForge ${requested} is not available for Minecraft ${mcVersion}`);
    return requested;
  }
  const chosen = builds.find((b) => b.stable) ?? builds[0];
  if (!chosen) throw new Error(`NeoForge has no release for Minecraft ${mcVersion}`);
  return chosen.version;
}

/** Relative path of the launch argument file the installer writes (unix_args.txt or win_args.txt). */
export function neoForgeArgsFile(version: string, platform: NodeJS.Platform = process.platform): string {
  if (!SAFE.test(version)) throw new Error("Invalid NeoForge version");
  return `libraries/net/neoforged/neoforge/${version}/${platform === "win32" ? "win" : "unix"}_args.txt`;
}

/** Launch files ("@…args.txt") are stored with the unix name; pick the one for this OS. */
export function argsFileForPlatform(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? file.replace(/unix_args\.txt$/, "win_args.txt") : file.replace(/win_args\.txt$/, "unix_args.txt");
}

/**
 * Download the NeoForge installer (SHA-256 from NeoForge's Maven) and run it with
 * `--installServer` in the server directory. It fetches the game and libraries itself and
 * writes the launch argument files; CraftPanel starts the server with `@…/unix_args.txt`.
 */
export async function installNeoForge(opts: {
  directory: string;
  version: string;
  javaPath: string;
  onProgress?: (stage: string, p: { received: number; total: number | null } | null) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { directory, version, javaPath, onProgress, signal } = opts;
  if (!SAFE.test(version)) throw new Error("Invalid NeoForge version");
  const name = `neoforge-${version}-installer.jar`;
  const url = `${MAVEN}/${version}/${name}`;
  const sha256 = await fetchChecksum(`${url}.sha256`, signal);
  const installer = path.join(directory, name);
  const stage = `Downloading NeoForge ${version} installer`;
  onProgress?.(stage, null);
  await download({ url, destination: installer, checksum: { algorithm: "sha256", value: sha256 }, onProgress: (p) => onProgress?.(stage, p), signal, maxBytes: 64 * 1024 * 1024 });
  try {
    onProgress?.(`Installing NeoForge ${version} (downloads Minecraft and libraries)`, null);
    await runInstaller(javaPath, installer, directory, signal);
  } finally {
    await fsp.rm(installer, { force: true });
    await fsp.rm(`${installer}.log`, { force: true });
  }
  const argsFile = neoForgeArgsFile(version, "linux");
  try {
    await fsp.access(path.join(directory, argsFileForPlatform(argsFile)));
  } catch {
    throw new Error("The NeoForge installer finished without creating its launch files");
  }
  // The installer's start scripts would ignore CraftPanel's memory and Java settings.
  for (const f of ["run.sh", "run.bat"]) await fsp.rm(path.join(directory, f), { force: true });
  return argsFile;
}

async function fetchChecksum(url: string, signal?: AbortSignal): Promise<string> {
  assertTrustedUrl(url);
  const res = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT }, signal: signal ?? AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`NeoForge checksum not available (HTTP ${res.status})`);
  const hex = (await res.text()).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("NeoForge published an invalid checksum");
  return hex;
}

function runInstaller(javaPath: string, installer: string, directory: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // argv only, no shell; the installer writes into the current directory.
    const child = spawn(javaPath, ["-jar", path.basename(installer), "--installServer"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    const tail: string[] = [];
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) tail.push(line.trim());
      tail.splice(0, Math.max(0, tail.length - 20));
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("Installation cancelled"));
      if (code === 0) return resolve();
      const hint = tail.filter((l) => /error|exception|failed/i.test(l)).slice(-3).join(" | ") || tail.slice(-3).join(" | ");
      reject(new Error(`The NeoForge installer failed (exit code ${code})${hint ? `: ${hint}` : ""}`));
    });
  });
}
