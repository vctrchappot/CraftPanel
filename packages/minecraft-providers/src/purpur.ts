import { fetchJson, TtlCache } from "./download";

const API = "https://api.purpurmc.org/v2/purpur";

export interface PurpurBuild {
  id: string;
  result: string;
  time: string;
  md5: string | null;
  changes: string[];
}

const versionsCache = new TtlCache<string[]>(10 * 60 * 1000);
const buildIdsCache = new TtlCache<string[]>(5 * 60 * 1000);
const buildCache = new TtlCache<PurpurBuild>(60 * 60 * 1000);

/** Minecraft versions Purpur publishes, newest first. */
export function listPurpurVersions(): Promise<string[]> {
  return versionsCache.get("v", async () => {
    const d = await fetchJson<{ versions: string[] }>(API);
    return d.versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).reverse();
  });
}

/** Build numbers for a version, newest first. */
export function listPurpurBuildIds(version: string): Promise<string[]> {
  return buildIdsCache.get(version, async () => {
    const d = await fetchJson<{ builds: { all: string[] } }>(`${API}/${encodeURIComponent(version)}`);
    return d.builds.all.filter((b) => /^\d+$/.test(b)).sort((a, b) => Number(b) - Number(a));
  });
}

export function getPurpurBuild(version: string, build: string): Promise<PurpurBuild> {
  return buildCache.get(`${version}/${build}`, async () => {
    const d = await fetchJson<{ build: string; result: string; timestamp: number; md5?: string; commits?: { description: string }[] }>(
      `${API}/${encodeURIComponent(version)}/${encodeURIComponent(build)}`,
    );
    return {
      id: d.build,
      result: d.result,
      time: new Date(d.timestamp).toISOString(),
      md5: d.md5 ?? null,
      changes: (d.commits ?? []).map((c) => c.description.split("\n")[0]).slice(0, 5),
    };
  });
}

export function purpurDownloadUrl(version: string, build: string): string {
  return `${API}/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`;
}

/** The requested build, or the newest successful one. */
export async function resolvePurpurBuild(version: string, build?: string | null): Promise<PurpurBuild> {
  const ids = await listPurpurBuildIds(version);
  if (!ids.length) throw new Error(`Purpur has no builds for ${version}`);
  if (build) {
    if (!ids.includes(String(build))) throw new Error(`Purpur build ${build} not found for ${version}`);
    return getPurpurBuild(version, String(build));
  }
  for (const id of ids.slice(0, 10)) {
    const b = await getPurpurBuild(version, id);
    if (b.result === "SUCCESS") return b;
  }
  throw new Error(`No successful Purpur build found for ${version}`);
}
