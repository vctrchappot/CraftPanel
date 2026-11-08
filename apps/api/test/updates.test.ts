import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRAFTPANEL_VERSION } from "@craftpanel/shared";
import { changelogSection, compareVersions, detectInstall, installerLog, newestArchive, UpdateService } from "../src/services/updates";
import type { SettingsService } from "../src/services/settings";

const settings = (updateCheck = true) => ({ get: async () => ({ updateCheck }) }) as unknown as SettingsService;
const release = (tag: string) => async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, published_at: "2026-11-07T00:00:00Z" }), { status: 200 });

describe("compareVersions", () => {
  it("orders versions numerically, pre-releases before releases", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });
});

describe("detectInstall", () => {
  it("reads the installer marker, falls back to git and manual", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-install-"));
    expect(detectInstall(dir)).toEqual({ method: "manual", updateCommand: null });
    await fs.mkdir(path.join(dir, ".git"));
    expect(detectInstall(dir, "linux")).toEqual({ method: "git", updateCommand: "./update.sh" });
    expect(detectInstall(dir, "win32").updateCommand).toBe("update.cmd");
    await fs.writeFile(path.join(dir, "install.json"), JSON.stringify({ method: "linux-service", updateCommand: "sudo /opt/craftpanel/update.sh" }));
    expect(detectInstall(dir)).toEqual({ method: "linux-service", updateCommand: "sudo /opt/craftpanel/update.sh" });
    expect(detectInstall(null).method).toBe("manual");
  });
});

describe("UpdateService", () => {
  it("reports a newer release and caches the answer", async () => {
    let calls = 0;
    const svc = new UpdateService(settings(), null, {}, async () => {
      calls++;
      return release("v999.0.0")();
    });
    const s = await svc.status();
    expect(s).toMatchObject({ enabled: true, current: CRAFTPANEL_VERSION, latest: "999.0.0", available: true, error: null });
    await svc.status();
    expect(calls).toBe(1);
    await svc.status(true);
    expect(calls).toBe(2);
  });

  it("does not offer older or equal versions", async () => {
    const svc = new UpdateService(settings(), null, {}, release(`v${CRAFTPANEL_VERSION}`));
    expect(await svc.status()).toMatchObject({ latest: CRAFTPANEL_VERSION, available: false });
  });

  it("handles no releases and network errors without failing", async () => {
    const none = new UpdateService(settings(), null, {}, async () => new Response("{}", { status: 404 }));
    expect(await none.status()).toMatchObject({ latest: null, available: false, error: null });
    const offline = new UpdateService(settings(), null, {}, async () => {
      throw new TypeError("fetch failed");
    });
    expect((await offline.status()).error).toContain("fetch failed");
  });

  it("can be turned off by setting or environment without contacting GitHub", async () => {
    const never = async () => {
      throw new Error("must not fetch");
    };
    expect(await new UpdateService(settings(false), null, {}, never).status()).toMatchObject({ enabled: false, error: null });
    expect(await new UpdateService(settings(), null, { CRAFTPANEL_UPDATE_CHECK: "false" }, never).status()).toMatchObject({ enabled: false });
  });
});

describe("updates from the dashboard", () => {
  const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "cp-upd-"));
  const store = (initial: Record<string, unknown> = {}) => {
    let s: Record<string, unknown> = { updateCheck: true, lastRunVersion: null, lastUpdateResultAt: null, ...initial };
    return { get: async () => s, set: async (p: Record<string, unknown>) => (s = { ...s, ...p }) } as unknown as SettingsService;
  };

  it("requires approval for the exact changed runtime and never approves a different release", async () => {
    const root = await tmp();
    const helper = { kind: "systemd", request: path.join(root, "requested"), log: path.join(root, "log"), result: path.join(root, "result") };
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "linux-service", updateCommand: "update", selfUpdate: helper }));
    const hash = "a".repeat(64);
    const fetchRelease: typeof fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("release.json")
      ? { runtime: { protocol: 1, sha256: hash } }
      : { tag_name: "v999.0.0", assets: [{ name: "release.json", browser_download_url: "https://github.com/vctrchappot/CraftPanel/releases/download/v999.0.0/release.json" }] }));
    const approvalFile = path.join(root, "runtime", "update-approval.json");
    const service = new UpdateService(settings(), root, {}, fetchRelease, undefined, { build: () => "b".repeat(64), approvalFile });
    await expect(service.startInstall()).rejects.toMatchObject({ code: "runtime_update_confirmation" });
    await expect(service.startInstall("c".repeat(64))).rejects.toMatchObject({ code: "runtime_update_confirmation" });
    await expect(fs.access(helper.request)).rejects.toThrow();
    await service.startInstall(hash);
    expect(JSON.parse(await fs.readFile(approvalFile, "utf8"))).toMatchObject({ sha256: hash });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("starts a dashboard-only update without runtime approval", async () => {
    const root = await tmp();
    const helper = { kind: "systemd", request: path.join(root, "requested"), log: path.join(root, "log"), result: path.join(root, "result") };
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "linux-service", updateCommand: "update", selfUpdate: helper }));
    const hash = "a".repeat(64);
    const fetchRelease: typeof fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("release.json")
      ? { runtime: { protocol: 1, sha256: hash } }
      : { tag_name: "v999.0.0", assets: [{ name: "release.json", browser_download_url: "https://github.com/vctrchappot/CraftPanel/releases/download/v999.0.0/release.json" }] }));
    const approvalFile = path.join(root, "approval.json");
    await new UpdateService(settings(), root, {}, fetchRelease, undefined, { build: () => hash, approvalFile }).startInstall();
    await expect(fs.access(helper.request)).resolves.toBeUndefined();
    await expect(fs.access(approvalFile)).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads the helper from install.json, also with a byte order mark", async () => {
    const dir = await tmp();
    const selfUpdate = { kind: "task", task: "CraftPanel Update", log: "C:/x/update.log", result: "C:/x/update-result.json" };
    await fs.writeFile(path.join(dir, "install.json"), "\uFEFF" + JSON.stringify({ method: "windows", updateCommand: "powershell …", selfUpdate }));
    expect(detectInstall(dir)).toEqual({ method: "windows", updateCommand: "powershell …", selfUpdate });
    // Anything unexpected in the helper is ignored, not run.
    await fs.writeFile(path.join(dir, "install.json"), JSON.stringify({ method: "windows", updateCommand: "x", selfUpdate: { ...selfUpdate, task: "a & calc" } }));
    expect(detectInstall(dir).selfUpdate).toBeUndefined();
  });

  it("finds the newest archive in a release folder and offers it", async () => {
    const dir = await tmp();
    for (const n of ["craftpanel-v0.9.0.tar.gz", "craftpanel-v999.1.0.tar.gz", "craftpanel-v999.0.5.tar.gz", "craftpanel-vx.tar.gz", "notes.txt"]) await fs.writeFile(path.join(dir, n), "");
    expect(newestArchive(dir)?.version).toBe("999.1.0");
    const svc = new UpdateService(settings(), null, { CRAFTPANEL_RELEASE_DIR: dir }, async () => {
      throw new Error("must not ask GitHub");
    });
    expect(await svc.status()).toMatchObject({ source: "folder", latest: "999.1.0", available: true, canInstall: false });
  });

  it("starts the systemd helper by creating the request file, then reports the installer's result", async () => {
    const root = await tmp();
    const data = await tmp();
    const helper = { kind: "systemd", request: path.join(data, "requested"), log: path.join(data, "update.log"), result: path.join(data, "update-result.json") };
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "linux-service", updateCommand: "sudo /opt/craftpanel/update.sh", selfUpdate: helper }));
    const svc = new UpdateService(settings(), root, {}, release("v999.0.0"));
    expect((await svc.status()).canInstall).toBe(true);
    const started = await svc.startInstall();
    expect(started).toMatchObject({ running: true, target: "999.0.0" });
    expect(JSON.parse(await fs.readFile(helper.request, "utf8"))).toMatchObject({ target: "999.0.0" });
    await expect(svc.startInstall()).rejects.toMatchObject({ code: "update_running" });
    await fs.writeFile(helper.log, "› Looking up the latest release…\n  Checksum verified.\n› Installing CraftPanel v999.0.0 to /opt/craftpanel…\n");
    expect((await svc.progress()).steps).toEqual(["Looking up the latest release…", "Installing CraftPanel v999.0.0 to /opt/craftpanel…"]);
    await fs.writeFile(helper.result, JSON.stringify({ ok: false, from: CRAFTPANEL_VERSION, to: "999.0.0", message: "did not start", rolledBack: true, finishedAt: Date.now() + 10 }));
    expect(await svc.progress()).toMatchObject({ running: false, result: { ok: false, rolledBack: true } });
  });

  it("runs the Windows update task without a shell", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "windows", updateCommand: "x", selfUpdate: { kind: "task", task: "CraftPanel Update", log: path.join(root, "l"), result: path.join(root, "r") } }));
    const calls: string[][] = [];
    const svc = new UpdateService(settings(), root, {}, release("v999.0.0"), async (file, args) => (calls.push([path.basename(file), ...args]), 0));
    await svc.startInstall();
    expect(calls).toEqual([["schtasks.exe", "/Run", "/TN", "CraftPanel Update"]]);
  });

  it("refuses when there is nothing newer or no helper", async () => {
    const root = await tmp();
    await expect(new UpdateService(settings(), root, {}, release("v999.0.0")).startInstall()).rejects.toMatchObject({ code: "update_manual" });
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "windows", updateCommand: "x", selfUpdate: { kind: "task", task: "T", log: "l", result: "r" } }));
    await expect(new UpdateService(settings(), root, {}, release(`v${CRAFTPANEL_VERSION}`)).startInstall()).rejects.toMatchObject({ code: "up_to_date" });
  });

  it("records version changes and failed updates once at startup", async () => {
    const root = await tmp();
    const result = path.join(root, "update-result.json");
    await fs.writeFile(path.join(root, "install.json"), JSON.stringify({ method: "windows", updateCommand: "x", selfUpdate: { kind: "task", task: "T", log: "l", result } }));
    await fs.writeFile(result, JSON.stringify({ ok: false, from: "0.0.1", to: "0.0.2", message: "Checksum mismatch.", rolledBack: false, finishedAt: 1000 }));
    const s = store({ lastRunVersion: "0.0.1" });
    const events: string[] = [];
    const svc = new UpdateService(s, root, {}, release("v1.0.0"));
    await svc.recordStartup(async (kind, message) => void events.push(`${kind}: ${message}`));
    await svc.recordStartup(async (kind, message) => void events.push(`${kind}: ${message}`));
    svc.stop();
    expect(events).toEqual([`craftpanel.updated: CraftPanel updated from 0.0.1 to ${CRAFTPANEL_VERSION}`, "craftpanel.update_failed: Update to 0.0.2 failed: Checksum mismatch."]);
  });

  it("extracts one version's section from the changelog", () => {
    const log = "# Changelog\n\n## Unreleased\n\n- next\n\n## 1.2.0 – 2026-12-01\n\n### Added\n- a\n\n## 1.1.0 – 2026-11-01\n\n- old\n";
    expect(changelogSection(log, "1.2.0")).toBe("### Added\n- a");
    expect(changelogSection(log, "1.1.0")).toBe("- old");
    expect(changelogSection(log, "9.9.9")).toBeNull();
  });
});

describe("installerLog", () => {
  it("drops PowerShell's transcript header and footer", () => {
    const text = "﻿**********************\r\nStart der Windows PowerShell-Aufzeichnung\r\nPSVersion: 5.1\r\n**********************\r\nUpdate requested\r\n> Installing CraftPanel v1.0.0...\r\nPS>TerminatingError(Invoke-WebRequest): \"timeout\"\r\n\r\n**********************\r\nEnde der Windows PowerShell-Aufzeichnung\r\n**********************\r\n";
    expect(installerLog(text)).toEqual(["Update requested", "> Installing CraftPanel v1.0.0..."]);
    expect(installerLog("› Looking up…\n  Checksum verified.\n")).toEqual(["› Looking up…", "  Checksum verified."]);
  });
});
