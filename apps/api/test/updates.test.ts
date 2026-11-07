import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRAFTPANEL_VERSION } from "@craftpanel/shared";
import { compareVersions, detectInstall, UpdateService } from "../src/services/updates";
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
