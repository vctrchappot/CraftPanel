import fs from "node:fs";
import path from "node:path";
import { CRAFTPANEL_REPO, CRAFTPANEL_REPO_URL, CRAFTPANEL_VERSION } from "@craftpanel/shared";
import type { SettingsService } from "./settings";

/**
 * How this copy was installed, so the dashboard can show the matching update command.
 * The one-line installers write install.json next to the app; git checkouts have .git.
 */
export interface InstallInfo {
  method: "linux-service" | "windows" | "git" | "manual";
  updateCommand: string | null;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: number | null;
  error: string | null;
  install: InstallInfo;
}

const RELEASES_URL = `${CRAFTPANEL_REPO_URL}/releases`;
const SUCCESS_TTL_MS = 6 * 3600_000;
const FAILURE_TTL_MS = 3600_000;

/** Compares x.y.z[-pre] versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core!.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function detectInstall(installRoot: string | null, platform = process.platform): InstallInfo {
  if (!installRoot) return { method: "manual", updateCommand: null };
  try {
    const info = JSON.parse(fs.readFileSync(path.join(installRoot, "install.json"), "utf8")) as Partial<InstallInfo>;
    if ((info.method === "linux-service" || info.method === "windows") && typeof info.updateCommand === "string") return { method: info.method, updateCommand: info.updateCommand };
  } catch {
    /* not installed by an installer */
  }
  if (fs.existsSync(path.join(installRoot, ".git"))) return { method: "git", updateCommand: platform === "win32" ? "update.cmd" : "./update.sh" };
  return { method: "manual", updateCommand: null };
}

/** Looks up the newest GitHub release. Read-only, no data about this install is sent. */
export class UpdateService {
  private cached: { status: Omit<UpdateStatus, "enabled" | "install">; expires: number } | null = null;
  private inflight: Promise<void> | null = null;
  readonly install: InstallInfo;

  constructor(
    private settings: SettingsService,
    installRoot: string | null,
    private env: NodeJS.ProcessEnv = process.env,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.install = detectInstall(installRoot);
  }

  /** Disabled with CRAFTPANEL_UPDATE_CHECK=false or in Settings. */
  async enabled(): Promise<boolean> {
    if (this.env.CRAFTPANEL_UPDATE_CHECK === "false") return false;
    return (await this.settings.get()).updateCheck;
  }

  async status(refresh = false): Promise<UpdateStatus> {
    const base = { enabled: await this.enabled(), install: this.install };
    if (!base.enabled) return { ...base, current: CRAFTPANEL_VERSION, latest: null, available: false, releaseUrl: null, publishedAt: null, checkedAt: null, error: null };
    if (refresh || !this.cached || this.cached.expires < Date.now()) {
      this.inflight ??= this.check().finally(() => (this.inflight = null));
      await this.inflight;
    }
    return { ...base, ...this.cached!.status };
  }

  private async check() {
    const now = Date.now();
    try {
      const res = await this.fetchImpl(`https://api.github.com/repos/${CRAFTPANEL_REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `CraftPanel/${CRAFTPANEL_VERSION}` },
        signal: AbortSignal.timeout(10_000),
      });
      // 404: no release published yet.
      if (res.status === 404) {
        this.cached = { status: { current: CRAFTPANEL_VERSION, latest: null, available: false, releaseUrl: RELEASES_URL, publishedAt: null, checkedAt: now, error: null }, expires: now + SUCCESS_TTL_MS };
        return;
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string };
      const latest = String(body.tag_name ?? "").replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error("Unexpected release format");
      this.cached = {
        status: {
          current: CRAFTPANEL_VERSION,
          latest,
          available: compareVersions(latest, CRAFTPANEL_VERSION) > 0,
          releaseUrl: body.html_url ?? RELEASES_URL,
          publishedAt: body.published_at ?? null,
          checkedAt: now,
          error: null,
        },
        expires: now + SUCCESS_TTL_MS,
      };
    } catch (err) {
      const message = err instanceof Error && err.name === "TimeoutError" ? "GitHub did not answer in time" : err instanceof Error ? err.message : String(err);
      this.cached = { status: { current: CRAFTPANEL_VERSION, latest: null, available: false, releaseUrl: RELEASES_URL, publishedAt: null, checkedAt: now, error: `Could not check for updates: ${message}` }, expires: now + FAILURE_TTL_MS };
    }
  }
}
