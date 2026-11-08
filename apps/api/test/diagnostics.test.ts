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
});
