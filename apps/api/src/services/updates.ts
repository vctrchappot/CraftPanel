import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError, CRAFTPANEL_REPO, CRAFTPANEL_REPO_URL, CRAFTPANEL_VERSION } from "@craftpanel/shared";
import type { SettingsService } from "./settings";

/**
 * How the dashboard can start an update: the installers register a privileged helper
 * (a systemd path unit on Linux, an on-demand scheduled task on Windows) that re-runs the
 * installer. CraftPanel itself only asks for "the newest release"; it never replaces itself.
 */
export type SelfUpdate =
  | { kind: "systemd"; request: string; log: string; result: string }
  | { kind: "task"; task: string; log: string; result: string };

/**
 * How this copy was installed, so the dashboard can show the matching update command.
 * The one-line installers write install.json next to the app; git checkouts have .git.
 */
export interface InstallInfo {
  method: "linux-service" | "windows" | "git" | "manual";
  updateCommand: string | null;
  selfUpdate?: SelfUpdate | null;
}

/** Written by the installer when an update finishes, successfully or not. */
export interface UpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  message: string;
  rolledBack: boolean;
  finishedAt: number;
}

export interface UpdateProgress {
  /** An update was requested from this process and hasn't finished yet. */
  running: boolean;
  target: string | null;
  startedAt: number | null;
  steps: string[];
  log: string[];
  result: UpdateResult | null;
}

export interface UpdateStatus {
  runtime?: { protocol: number; sha256: string } | null;
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  /** Release notes (Markdown) from GitHub. */
  notes: string | null;
  /** Where releases come from: GitHub or a local folder (CRAFTPANEL_RELEASE_DIR). */
  source: "github" | "folder";
  checkedAt: number | null;
  error: string | null;
  install: Omit<InstallInfo, "selfUpdate">;
  /** The dashboard can install the update with one click. */
  canInstall: boolean;
  lastResult: UpdateResult | null;
}

const RELEASES_URL = `${CRAFTPANEL_REPO_URL}/releases`;
const SUCCESS_TTL_MS = 6 * 3600_000;
const FAILURE_TTL_MS = 3600_000;
const ARCHIVE_RE = /^craftpanel-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tar\.gz$/;

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

function parseSelfUpdate(v: unknown): SelfUpdate | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.log !== "string" || typeof o.result !== "string") return null;
  if (o.kind === "systemd" && typeof o.request === "string") return { kind: "systemd", request: o.request, log: o.log, result: o.result };
  if (o.kind === "task" && typeof o.task === "string" && /^[\w .-]{1,80}$/.test(o.task)) return { kind: "task", task: o.task, log: o.log, result: o.result };
  return null;
}

export function detectInstall(installRoot: string | null, platform = process.platform): InstallInfo {
  if (!installRoot) return { method: "manual", updateCommand: null };
  try {
    const info = readJson<Partial<InstallInfo> & { selfUpdate?: unknown }>(path.join(installRoot, "install.json")) ?? {};
    if ((info.method === "linux-service" || info.method === "windows") && typeof info.updateCommand === "string") {
      const selfUpdate = parseSelfUpdate(info.selfUpdate);
      return { method: info.method, updateCommand: info.updateCommand, ...(selfUpdate ? { selfUpdate } : {}) };
    }
  } catch {
    /* not installed by an installer */
  }
  if (fs.existsSync(path.join(installRoot, ".git"))) return { method: "git", updateCommand: platform === "win32" ? "update.cmd" : "./update.sh" };
  return { method: "manual", updateCommand: null };
}

/** The newest release archive in a local release folder. */
export function newestArchive(dir: string): { version: string; file: string } | null {
  let best: { version: string; file: string } | null = null;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = ARCHIVE_RE.exec(name);
    if (m && (!best || compareVersions(m[1]!, best.version) > 0)) best = { version: m[1]!, file: path.join(dir, name) };
  }
  return best;
}

/** The section of CHANGELOG.md for one version ("## 0.2.0 – 2026-12-01"), without its heading. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## /.test(l) && l.slice(3).trim().split(/\s/)[0] === version);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body || null;
}

function readJson<T>(file: string): T | null {
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a byte order mark.
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

/** Looks up the newest GitHub release (or the newest archive in a local folder) and can hand an update to the installer. */
export class UpdateService {
  private cached: { status: Pick<UpdateStatus, "current" | "latest" | "available" | "releaseUrl" | "publishedAt" | "notes" | "checkedAt" | "error" | "runtime">; expires: number } | null = null;
  private inflight: Promise<void> | null = null;
  private pending: { target: string | null; startedAt: number } | null = null;
  readonly install: InstallInfo;

  constructor(
    private settings: SettingsService,
    private installRoot: string | null,
    private env: NodeJS.ProcessEnv = process.env,
    private fetchImpl: typeof fetch = fetch,
    private run: (file: string, args: string[]) => Promise<number> = runQuiet,
    private runtime?: { build: () => string | null; approvalFile: string },
  ) {
    this.install = detectInstall(installRoot);
  }

  private get releaseDir() {
    return this.env.CRAFTPANEL_RELEASE_DIR?.trim() || null;
  }

  /** Disabled with CRAFTPANEL_UPDATE_CHECK=false or in Settings. */
  async enabled(): Promise<boolean> {
    if (this.env.CRAFTPANEL_UPDATE_CHECK === "false") return false;
    return (await this.settings.get()).updateCheck;
  }

  async status(refresh = false): Promise<UpdateStatus> {
    const { selfUpdate, ...install } = this.install;
    const lastResult = selfUpdate ? readJson<UpdateResult>(selfUpdate.result) : null;
    const base = { enabled: await this.enabled(), install, source: this.releaseDir ? ("folder" as const) : ("github" as const), lastResult };
    if (!base.enabled) return { ...base, current: CRAFTPANEL_VERSION, latest: null, available: false, releaseUrl: null, publishedAt: null, notes: null, checkedAt: null, error: null, canInstall: false };
    if (refresh || !this.cached || this.cached.expires < Date.now()) {
      this.inflight ??= this.check().finally(() => (this.inflight = null));
      await this.inflight;
    }
    const s = this.cached!.status;
    return { ...base, ...s, canInstall: !!selfUpdate && s.available && (!this.runtime || !!s.runtime) };
  }

  private async check() {
    const now = Date.now();
    const empty = { current: CRAFTPANEL_VERSION, latest: null, available: false, releaseUrl: RELEASES_URL, publishedAt: null, notes: null, checkedAt: now, error: null, runtime: null as UpdateStatus["runtime"] };
    if (this.releaseDir) {
      const newest = newestArchive(this.releaseDir);
      const available = !!newest && compareVersions(newest.version, CRAFTPANEL_VERSION) > 0;
      // The release notes are the archive's own CHANGELOG.md.
      const changelog = available ? await readFromArchive(newest.file, `craftpanel-v${newest.version}/CHANGELOG.md`) : null;
      const manifest = available ? await readFromArchive(newest.file, `craftpanel-v${newest.version}/release.json`) : null;
      this.cached = {
        status: newest
          ? { ...empty, latest: newest.version, available, releaseUrl: null, notes: changelog ? changelogSection(changelog, newest.version) : null, runtime: parseRuntimeManifest(manifest) }
          : { ...empty, releaseUrl: null, error: `No craftpanel-vX.Y.Z.tar.gz in ${this.releaseDir}` },
        expires: now + 60_000,
      };
      return;
    }
    try {
      const res = await this.fetchImpl(`https://api.github.com/repos/${CRAFTPANEL_REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `CraftPanel/${CRAFTPANEL_VERSION}` },
        signal: AbortSignal.timeout(10_000),
      });
      // 404: no release published yet.
      if (res.status === 404) {
        this.cached = { status: empty, expires: now + SUCCESS_TTL_MS };
        return;
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
      const latest = String(body.tag_name ?? "").replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error("Unexpected release format");
      let runtime: UpdateStatus["runtime"] = null;
      const asset = body.assets?.find((a) => a.name === "release.json");
      if (asset?.browser_download_url.startsWith(`https://github.com/${CRAFTPANEL_REPO}/releases/download/`)) {
        const manifest = await this.fetchImpl(asset.browser_download_url, { signal: AbortSignal.timeout(10_000) });
        if (manifest.ok) runtime = parseRuntimeManifest(await manifest.text());
      }
      this.cached = {
        status: {
          ...empty,
          latest,
          available: compareVersions(latest, CRAFTPANEL_VERSION) > 0,
          releaseUrl: body.html_url ?? RELEASES_URL,
          publishedAt: body.published_at ?? null,
          notes: typeof body.body === "string" ? body.body.slice(0, 20_000) : null,
          runtime,
        },
        expires: now + SUCCESS_TTL_MS,
      };
    } catch (err) {
      const message = err instanceof Error && err.name === "TimeoutError" ? "GitHub did not answer in time" : err instanceof Error ? err.message : String(err);
      this.cached = { status: { ...empty, error: `Could not check for updates: ${message}` }, expires: now + FAILURE_TTL_MS };
    }
  }

  /** Ask the installer's helper to install the newest release. CraftPanel stops and restarts during it. */
  async startInstall(approvedRuntime?: string): Promise<UpdateProgress> {
    const helper = this.install.selfUpdate;
    if (!helper) throw new AppError(400, "update_manual", "This installation can't update itself from the dashboard", this.install.updateCommand ? `Run: ${this.install.updateCommand}` : "Reinstall with the one-line installer from the README.");
    const status = await this.status(true);
    if (!status.available) throw new AppError(409, "up_to_date", status.error ?? `CraftPanel ${CRAFTPANEL_VERSION} is the newest version`);
    if ((await this.progress()).running) throw new AppError(409, "update_running", "An update is already running");
    if (this.runtime) {
      if (!status.runtime || status.runtime.protocol !== 1) throw new AppError(409, "runtime_update_unknown", "This release has no compatible runtime manifest", "Use the manual installer after reviewing its maintenance requirements.");
      const current = this.runtime.build();
      if (!current) throw new AppError(503, "runtime_disconnected", "Reconnect the runtime before updating");
      if (current !== status.runtime.sha256) {
        if (approvedRuntime !== status.runtime.sha256) throw new AppError(409, "runtime_update_confirmation", "This update changes the Minecraft runtime and stops its game servers", "Review the affected servers and confirm this exact runtime update.");
        fs.mkdirSync(path.dirname(this.runtime.approvalFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.runtime.approvalFile, JSON.stringify({ sha256: status.runtime.sha256, expiresAt: Date.now() + 10 * 60_000 }) + "\n", { mode: 0o600 });
      }
    }
    this.pending = { target: status.latest, startedAt: Date.now() };
    try {
      if (helper.kind === "systemd") {
        fs.writeFileSync(helper.request, `${JSON.stringify({ requestedAt: this.pending.startedAt, target: status.latest })}\n`);
      } else {
        const code = await this.run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe"), ["/Run", "/TN", helper.task]);
        if (code !== 0) throw new Error(`schtasks exited with ${code}`);
      }
    } catch (err) {
      this.pending = null;
      if (this.runtime) fs.rmSync(this.runtime.approvalFile, { force: true });
      throw new AppError(500, "update_start_failed", `Could not start the update: ${(err as Error).message}`, this.install.updateCommand ? `Run it yourself: ${this.install.updateCommand}` : undefined);
    }
    return this.progress();
  }

  /** What the installer has done so far (its log) and how the last update ended. */
  async progress(): Promise<UpdateProgress> {
    const helper = this.install.selfUpdate;
    const result = helper ? readJson<UpdateResult>(helper.result) : null;
    let log: string[] = [];
    // While an update runs: its log so far. After a restart (pending is gone): the log of a failed update, to explain it.
    const since = this.pending ? this.pending.startedAt - 2000 : result && !result.ok ? result.finishedAt - 30 * 60_000 : null;
    if (helper && since !== null) {
      try {
        const st = fs.statSync(helper.log);
        // An old log from a previous update doesn't count.
        if (st.mtimeMs >= since) log = installerLog(fs.readFileSync(helper.log, "utf8")).slice(-200);
      } catch {
        /* not started yet */
      }
    }
    const finished = !!result && !!this.pending && result.finishedAt >= this.pending.startedAt;
    if (this.pending && Date.now() - this.pending.startedAt > 30 * 60_000) this.pending = null;
    const steps = log.filter((l) => /^[›>] /.test(l)).map((l) => l.slice(2).trim());
    return { running: !!this.pending && !finished, target: this.pending?.target ?? null, startedAt: this.pending?.startedAt ?? null, steps, log, result };
  }

  /** Release notes of the running version from the bundled CHANGELOG.md. */
  whatsNew(): { version: string; notes: string | null } {
    let notes: string | null = null;
    if (this.installRoot) {
      try {
        notes = changelogSection(fs.readFileSync(path.join(this.installRoot, "CHANGELOG.md"), "utf8"), CRAFTPANEL_VERSION);
      } catch {
        /* no changelog next to the app */
      }
    }
    return { version: CRAFTPANEL_VERSION, notes };
  }

  /**
   * Called at startup: notices a version change (by any update method) and how dashboard updates
   * end, so both show up in the activity log and notifications. After a rollback the old version is
   * already running again when the installer writes its result, so the result file is also polled.
   */
  async recordStartup(record: Recorder) {
    const s = await this.settings.get();
    if (s.lastRunVersion !== CRAFTPANEL_VERSION) {
      if (s.lastRunVersion) {
        const older = compareVersions(CRAFTPANEL_VERSION, s.lastRunVersion) < 0;
        await record("craftpanel.updated", `CraftPanel ${older ? "went back" : "updated"} from ${s.lastRunVersion} to ${CRAFTPANEL_VERSION}`, "info");
      }
      await this.settings.set({ lastRunVersion: CRAFTPANEL_VERSION });
    }
    await this.recordResult(record);
    if (this.install.selfUpdate && !this.resultTimer) {
      this.resultTimer = setInterval(() => void this.recordResult(record).catch(() => undefined), 15_000);
      this.resultTimer.unref();
    }
  }

  stop() {
    if (this.resultTimer) clearInterval(this.resultTimer);
    this.resultTimer = null;
  }

  private resultTimer: NodeJS.Timeout | null = null;

  async recordResult(record: Recorder) {
    const helper = this.install.selfUpdate;
    const result = helper ? readJson<UpdateResult>(helper.result) : null;
    if (!result || result.finishedAt <= ((await this.settings.get()).lastUpdateResultAt ?? 0)) return;
    await this.settings.set({ lastUpdateResultAt: result.finishedAt });
    if (!result.ok) await record("craftpanel.update_failed", `Update${result.to ? ` to ${result.to}` : ""} failed: ${result.message}`, "error");
  }
}

function parseRuntimeManifest(text: string | null): UpdateStatus["runtime"] {
  try {
    const r = JSON.parse(text ?? "null")?.runtime;
    return r?.protocol === 1 && typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256) ? { protocol: r.protocol, sha256: r.sha256 } : null;
  } catch { return null; }
}

type Recorder = (kind: string, message: string, level: "info" | "error") => Promise<void>;

/** The installer's output without the header and footer blocks PowerShell's Start-Transcript adds. */
export function installerLog(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\*{10,}$/.test(line.trim())) {
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock && line.trim() && !/^(Transcript started|Transkript wurde gestartet|PS>)/.test(line)) out.push(line);
  }
  return out;
}

/** One text file from a .tar.gz, via the system tar (also part of Windows 10 and newer). */
function readFromArchive(archive: string, member: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("tar", ["-xzOf", archive, member], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15_000 });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 1024 * 1024) chunks.push(d);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
  });
}

function runQuiet(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
