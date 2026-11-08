#!/usr/bin/env node
// Runs the API (with reload) and the Next.js dev server together.
// Data lives in ./.data so development never touches a real installation.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.CRAFTPANEL_PORT ?? "8080";
const webPort = process.env.WEB_PORT ?? "3000";
const shell = process.platform === "win32";

const procs = [
  spawn("pnpm", ["--filter", "@craftpanel/api", "exec", "tsx", "src/runtime.ts"], {
    cwd: root,
    stdio: "inherit",
    shell,
    env: { ...process.env, CRAFTPANEL_DATA_DIR: process.env.CRAFTPANEL_DATA_DIR ?? path.join(root, ".data") },
  }),
  spawn("pnpm", ["--filter", "@craftpanel/api", "dev"], {
    cwd: root,
    stdio: "inherit",
    shell,
    env: {
      ...process.env,
      CRAFTPANEL_PORT: apiPort,
      CRAFTPANEL_DATA_DIR: process.env.CRAFTPANEL_DATA_DIR ?? path.join(root, ".data"),
      CRAFTPANEL_CORS_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
    },
  }),
  spawn("pnpm", ["--filter", "@craftpanel/web", "exec", "next", "dev", "--port", webPort], {
    cwd: root,
    stdio: "inherit",
    shell,
    env: { ...process.env, NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`, NEXT_TELEMETRY_DISABLED: "1" },
  }),
];

console.log(`\n  CraftPanel dev: dashboard http://localhost:${webPort}  ·  API http://localhost:${apiPort}\n`);
const stop = () => {
  for (const p of procs) p.kill("SIGINT");
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && code !== 0 && stop());
