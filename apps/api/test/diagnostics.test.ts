import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { deploymentDiagnostics } from "../src/diagnostics";

describe("read-only deployment diagnostics", () => {
  it("does not initialize the application or create a missing data directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-doctor-"));
    try {
      const data = path.join(root, "not-initialized");
      const report = await deploymentDiagnostics(loadConfig({ CRAFTPANEL_DATA_DIR: data }));
      expect(report.ok).toBe(true);
      expect(report.checks).toContainEqual(expect.objectContaining({ id: "database", status: "warning" }));
      await expect(fs.access(data)).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("detects an invalid database and HTTPS configuration without modifying database contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-doctor-"));
    try {
      const file = path.join(root, "craftpanel.db");
      await fs.writeFile(file, "not a database");
      const config = loadConfig({ CRAFTPANEL_DATA_DIR: root, CRAFTPANEL_PUBLIC_URL: "https://panel.example", CRAFTPANEL_PROFILE: "proxy" });
      let report = await deploymentDiagnostics({ ...config, trustProxy: false });
      expect(report.ok).toBe(false);
      expect(report.checks).toContainEqual(expect.objectContaining({ id: "database", status: "error" }));
      expect(report.checks).toContainEqual(expect.objectContaining({ id: "https-config", status: "error" }));
      expect(await fs.readFile(file, "utf8")).toBe("not a database");
      await fs.unlink(file);
      const db = new DatabaseSync(file); db.exec("CREATE TABLE keep (id INTEGER); INSERT INTO keep VALUES (42)"); db.close();
      const before = await fs.readFile(file);
      report = await deploymentDiagnostics({ ...config, trustProxy: ["127.0.0.1"] }, { transportSecure: false });
      expect(report.ok).toBe(true);
      expect(report.checks).toContainEqual(expect.objectContaining({ id: "transport", status: "warning" }));
      expect(await fs.readFile(file)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reports what the runtime isolates and limits, and warns when it does not", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-doctor-"));
    try {
      const config = loadConfig({ CRAFTPANEL_DATA_DIR: root });
      const check = async (runtime: Parameters<typeof deploymentDiagnostics>[2], id: string) =>
        (await deploymentDiagnostics(config, undefined, runtime)).checks.find((c) => c.id === id);
      expect(await check(undefined, "isolation")).toBeUndefined();
      expect(await check({ connected: false }, "runtime")).toMatchObject({ status: "warning" });
      expect(await check({ connected: true, isolation: { mode: "isolated", method: "accounts", accounts: 32 } }, "isolation")).toMatchObject({ status: "ok", message: expect.stringContaining("32 available") });
      expect(await check({ connected: true, isolation: { mode: "isolated", method: "token" } }, "isolation")).toMatchObject({ status: "ok", message: expect.stringContaining("restricted token") });
      expect(await check({ connected: true, isolation: { mode: "shared", reason: "No game accounts." } }, "isolation"))
        .toMatchObject({ status: "warning", message: "Servers are not isolated: No game accounts", hint: expect.stringContaining("installer") });
      expect(await check({ connected: true }, "isolation")).toMatchObject({ status: "warning" });
      expect(await check({ connected: true, limits: { available: true, controllers: ["memory", "cpu", "pids"] } }, "limits")).toMatchObject({ status: "ok", message: expect.stringContaining("memory, cpu, pids") });
      expect(await check({ connected: true, limits: { available: false, reason: "cgroup v1" } }, "limits")).toMatchObject({ status: "warning", message: "Resource limits are not enforced: cgroup v1" });
      expect(await check({ connected: true, limits: { available: true, controllers: ["cpu"], reason: "The kernel does not offer: memory" } }, "limits")).toMatchObject({ status: "warning" });
      // Warnings never fail the report.
      expect((await deploymentDiagnostics(config, undefined, { connected: false })).ok).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
