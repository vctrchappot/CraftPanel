import fsp from "node:fs/promises";
import path from "node:path";
import { download, hashFile } from "./download";

/**
 * Log4Shell (CVE-2021-44228) protection for Minecraft 1.7–1.18, following
 * Mojang's guidance for server owners:
 *   1.18 (before 1.18.1) and 1.17.x  → -Dlog4j2.formatMsgNoLookups=true
 *   1.12–1.16.5                      → Mojang's patched log config (%msg{nolookups})
 *   1.7–1.11.2                       → Mojang's patched log config (drops messages containing "${")
 * 1.18.1+ and anything before 1.7 are not affected. The same applies to Paper,
 * Purpur and Fabric servers, which use the game's log4j setup.
 */
export interface Log4jConfigFile {
  name: string;
  url: string;
  sha1: string;
}

export interface Log4shellMitigation {
  kind: "jvm-flag" | "log-config";
  jvmArgs: string[];
  configFile: Log4jConfigFile | null;
  description: string;
}

const CONFIG_112_116: Log4jConfigFile = {
  name: "log4j2_112-116.xml",
  url: "https://launcher.mojang.com/v1/objects/02937d122c86ce73319ef9975b58896fc1b491d1/log4j2_112-116.xml",
  sha1: "02937d122c86ce73319ef9975b58896fc1b491d1",
};
const CONFIG_17_111: Log4jConfigFile = {
  name: "log4j2_17-111.xml",
  url: "https://launcher.mojang.com/v1/objects/4bb89a97a66f350bc9f73b3ca8509632682aea2e/log4j2_17-111.xml",
  sha1: "4bb89a97a66f350bc9f73b3ca8509632682aea2e",
};

const FLAG = "-Dlog4j2.formatMsgNoLookups=true";

function withConfig(file: Log4jConfigFile): Log4shellMitigation {
  return { kind: "log-config", jvmArgs: [`-Dlog4j.configurationFile=${file.name}`], configFile: file, description: `Mojang's patched logging config (${file.name})` };
}

/** The protection a Minecraft version needs, or null when it is not affected. */
export function log4shellMitigation(version: string): Log4shellMitigation | null {
  // Releases, pre-releases and release candidates: 1.16.5, 1.18-pre1, 1.17.1-rc2.
  const release = /^1\.(\d+)(?:\.(\d+))?(?:[- ](?:pre|rc|Pre-Release ?)\d*)?$/i.exec(version);
  if (release) {
    const minor = Number(release[1]);
    const patch = Number(release[2] ?? 0);
    if (minor === 17 || (minor === 18 && patch === 0)) return { kind: "jvm-flag", jvmArgs: [FLAG], configFile: null, description: `JVM flag ${FLAG}` };
    if (minor >= 12 && minor <= 16) return withConfig(CONFIG_112_116);
    if (minor >= 7 && minor <= 11) return withConfig(CONFIG_17_111);
    return null;
  }
  // Weekly snapshots between 1.7 (13w36a) and 1.18.1: the filtering config works with every log4j version they shipped.
  const snapshot = /^(\d\d)w(\d\d)[a-z]$/.exec(version);
  if (snapshot) {
    const week = Number(snapshot[1]) * 100 + Number(snapshot[2]);
    if (week >= 1336 && week <= 2149) return withConfig(CONFIG_17_111);
  }
  return null;
}

/** True when the user's own JVM arguments already set a log4j configuration or the lookup flag. */
export function hasOwnLog4jSettings(jvmArgs: string[]): boolean {
  return jvmArgs.some((a) => a.startsWith("-Dlog4j.configurationFile=") || a.startsWith("-Dlog4j2.formatMsgNoLookups="));
}

/** Make sure the patched config file is in the server directory (downloaded from Mojang, SHA-1 verified). */
export async function ensureLog4jConfig(directory: string, file: Log4jConfigFile, signal?: AbortSignal): Promise<void> {
  const target = path.join(directory, file.name);
  try {
    await fsp.access(target);
    if ((await hashFile(target, "sha1")) === file.sha1) return;
  } catch {
    /* missing: download below */
  }
  await download({ url: file.url, destination: target, checksum: { algorithm: "sha1", value: file.sha1 }, signal, maxBytes: 64 * 1024 });
}
