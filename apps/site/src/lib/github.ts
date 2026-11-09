// Repository facts fetched once at build time, so visitors' browsers never call GitHub.
// Every deploy refreshes them; on any error the page falls back to the package version.
const REPO = "vctrchappot/CraftPanel";

export interface RepoFacts {
  stars: number | null;
  release: { tag: string; date: string; url: string } | null;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "craftpanel-site" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/**
 * The release to show. A deploy runs when the release commit is pushed, before GitHub Actions has published the
 * release, so "latest" is still the previous one then. This build's own version is never older than the latest
 * release, so show it instead of an outdated tag.
 */
export function shownRelease(latest: RepoFacts["release"], version: string): NonNullable<RepoFacts["release"]> {
  if (latest && compareVersions(latest.tag, version) >= 0) return latest;
  return { tag: `v${version}`, date: "", url: `https://github.com/${REPO}/releases/tag/v${version}` };
}

let cached: Promise<RepoFacts> | null = null;

export function repoFacts(): Promise<RepoFacts> {
  cached ??= (async () => {
    const [repo, release] = await Promise.all([
      get<{ stargazers_count: number }>(`repos/${REPO}`),
      get<{ tag_name: string; published_at: string; html_url: string }>(`repos/${REPO}/releases/latest`),
    ]);
    return {
      stars: repo?.stargazers_count ?? null,
      release: release ? { tag: release.tag_name, date: release.published_at, url: release.html_url } : null,
    };
  })();
  return cached;
}
