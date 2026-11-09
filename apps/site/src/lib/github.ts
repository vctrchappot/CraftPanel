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
