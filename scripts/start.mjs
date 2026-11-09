#!/usr/bin/env node
// `pnpm start` in a checkout: starts the Minecraft runtime (unless one already runs for this data
// directory, e.g. the installed service or another terminal) and then the dashboard. Arguments go
// to the dashboard (`pnpm start:lan` → --profile lan). Ctrl+C reaches both processes: the
// dashboard closes and the runtime saves and stops its Minecraft servers. Installed services
// (deploy/install.sh, install.ps1) run the two processes separately and don't use this script.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps", "api", "dist");
const runtimeEntry = path.join(dist, "runtime.js");
const status = () => spawnSync(process.execPath, [runtimeEntry, "--status"], { cwd: root, stdio: "ignore", windowsHide: true }).status === 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let runtime = null;
let stopping = false;
if (status()) {
  console.log("  Using the Minecraft runtime that is already running for this data directory.");
} else {
  runtime = spawn(process.execPath, [runtimeEntry], { cwd: root, stdio: "inherit" });
  runtime.on("exit", (code) => {
    runtime = null;
    if (!stopping) console.warn(`\n  The Minecraft runtime stopped (exit code ${code}); the dashboard shows servers as unknown until it runs again (pnpm start:runtime).`);
  });
  const deadline = Date.now() + 20_000;
  while (runtime && !status()) {
    if (Date.now() > deadline) { console.error("  The Minecraft runtime did not become ready within 20 seconds."); break; }
    await sleep(250);
  }
}

const dashboard = spawn(process.execPath, [path.join(dist, "index.js"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
// The terminal delivers Ctrl+C to the whole process group; both children shut down by themselves.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => { stopping = true; });
dashboard.on("exit", (code) => {
  stopping = true;
  // Only a runtime started here is stopped here, and gracefully: it saves and stops its servers.
  if (runtime) spawnSync(process.execPath, [runtimeEntry, "--shutdown"], { cwd: root, stdio: "ignore", windowsHide: true });
  const done = () => process.exit(code ?? 0);
  if (!runtime) done();
  else runtime.on("exit", done);
});
