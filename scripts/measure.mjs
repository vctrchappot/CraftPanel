#!/usr/bin/env node
// Measures the built panel on this machine: startup time, idle CPU and memory,
// API latency and bundle sizes. Uses a temporary data directory and its own
// port, so it never touches a real installation.
//
//   pnpm build && node scripts/measure.mjs [--port 8097] [--idle 60] [--json]
//
// Run it on a Raspberry Pi or small VPS to compare against the numbers in docs/STATUS.md.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/api/dist");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt("port", 8097));
const idleSeconds = Number(opt("idle", 60));
const asJson = args.includes("--json");
const base = `http://127.0.0.1:${port}`;

if (!fs.existsSync(path.join(dist, "index.js"))) {
  console.error("apps/api/dist/index.js not found. Run `pnpm build` first.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-measure-"));
const results = { machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGb: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version } };

/** CPU time (ms) and resident memory (bytes) of a process, from the OS. */
async function usage(pid) {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(f[11]) + Number(f[12]);
    return { cpuMs: ticks * 10, rss: Number(f[21]) * 4096 };
  }
  const out = await new Promise((resolve, reject) => {
    const [file, argv] =
      process.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid}; "$([int64]$p.TotalProcessorTime.TotalMilliseconds) $($p.WorkingSet64)"`]]
        : ["ps", ["-o", "time=,rss=", "-p", String(pid)]];
    const c = spawn(file, argv, { windowsHide: true });
    let s = "";
    c.stdout.on("data", (d) => (s += d));
    c.on("close", () => resolve(s.trim()));
    c.on("error", reject);
  });
  if (process.platform === "win32") {
    const [cpu, rss] = out.split(/\s+/).map(Number);
    return { cpuMs: cpu, rss };
  }
  const [time, rss] = out.split(/\s+/);
  const [m, s] = time.split(":").map(Number);
  return { cpuMs: (m * 60 + s) * 1000, rss: Number(rss) * 1024 };
}

async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return Date.now();
    } catch {
      /* not up yet */
    }
    await sleep(20);
  }
  throw new Error("The panel did not start within 30 s");
}

let cookie = "";
let csrf = "";
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}" });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}

const env = { ...process.env, CRAFTPANEL_PORT: String(port), CRAFTPANEL_HOST: "127.0.0.1", CRAFTPANEL_DATA_DIR: dataDir, CRAFTPANEL_UPDATE_CHECK: "false", CRAFTPANEL_LOG_LEVEL: "warn" };
const t0 = Date.now();
const child = spawn(process.execPath, [path.join(dist, "index.js")], { env, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
try {
  const up = await waitHealthy();
  results.startupMs = up - t0;
  const setup = await call("POST", "/api/auth/setup", { username: "measure", password: "measure-password-1" });
  csrf = setup.csrfToken;

  const latency = {};
  for (const url of ["/api/health", "/api/auth/state", "/api/servers", "/api/system", "/api/activity", "/api/backups", "/"]) {
    const times = [];
    for (let i = 0; i < 100; i++) {
      const s = performance.now();
      const r = await fetch(base + url, { headers: { cookie } });
      await r.arrayBuffer();
      times.push(performance.now() - s);
    }
    latency[url] = { p50: percentile(times, 50), p95: percentile(times, 95) };
  }
  results.latencyMs = latency;

  await sleep(5000); // let GC and the database settle after the request burst
  const before = await usage(child.pid);
  await sleep(idleSeconds * 1000);
  const after = await usage(child.pid);
  results.idle = {
    seconds: idleSeconds,
    cpuPercentOfOneCore: +(((after.cpuMs - before.cpuMs) / (idleSeconds * 1000)) * 100).toFixed(2),
    rssMb: +(after.rss / 1024 ** 2).toFixed(1),
  };
  results.databaseKb = Math.round(
    ["craftpanel.db", "craftpanel.db-wal"].map((f) => path.join(dataDir, f)).filter(fs.existsSync).reduce((n, f) => n + fs.statSync(f).size, 0) / 1024,
  );
} finally {
  child.kill();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const allWebFiles = walk(path.join(dist, "web"));
const webFiles = allWebFiles.filter((f) => !/\.(br|gz)$/.test(f));
// What a browser downloads: the brotli copy where the build wrote one.
const transferred = (f) => (fs.existsSync(f + ".br") ? size(f + ".br") : size(f));
results.bundleKb = {
  api: Math.round(size(path.join(dist, "index.js")) / 1024),
  apiSourceMap: Math.round(size(path.join(dist, "index.js.map")) / 1024),
  webTotal: Math.round(webFiles.reduce((n, f) => n + size(f), 0) / 1024),
  webJs: Math.round(webFiles.filter((f) => f.endsWith(".js")).reduce((n, f) => n + size(f), 0) / 1024),
  webJsBrotli: Math.round(webFiles.filter((f) => f.endsWith(".js")).reduce((n, f) => n + transferred(f), 0) / 1024),
};

if (asJson) console.log(JSON.stringify(results, null, 2));
else {
  const m = results.machine;
  console.log(`Machine     ${m.platform}/${m.arch}, ${m.cpus} × ${m.cpuModel}, ${m.memoryGb} GB, Node ${m.node}`);
  console.log(`Startup     ${results.startupMs} ms until /api/health answers (fresh data directory)`);
  console.log(`Idle        ${results.idle.cpuPercentOfOneCore}% of one core over ${results.idle.seconds} s, ${results.idle.rssMb} MB resident`);
  console.log(`Database    ${results.databaseKb} KB`);
  console.log(`Bundles     API ${results.bundleKb.api} KB (+ ${results.bundleKb.apiSourceMap} KB source map), dashboard ${results.bundleKb.webTotal} KB (${results.bundleKb.webJs} KB JS, ${results.bundleKb.webJsBrotli} KB over the wire)`);
  console.log("Latency     p50 / p95 ms (100 sequential requests each)");
  for (const [url, l] of Object.entries(results.latencyMs)) console.log(`  ${url.padEnd(18)} ${String(l.p50).padStart(6)} / ${l.p95}`);
}
