import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.E2E_PORT ?? 8090);
const dataDir = process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), `craftpanel-e2e-${Date.now()}`);

// End-to-end tests run against the production build with a throwaway data
// directory. They download real server software and start a real server.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60 * 1000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: [{
    command: "node apps/api/dist/runtime.js",
    wait: { stdout: /runtime protocol 1 ready/ },
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CRAFTPANEL_DATA_DIR: dataDir },
  }, {
    command: "node apps/api/dist/index.js",
    url: `http://127.0.0.1:${port}/api/ready`,
    reuseExistingServer: !!process.env.E2E_REUSE,
    timeout: 60_000,
    env: {
      CRAFTPANEL_PORT: String(port),
      CRAFTPANEL_DATA_DIR: dataDir,
    },
  }],
});
