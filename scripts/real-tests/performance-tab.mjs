// The Performance tab's data on a real server: metric history sampled without a dashboard, the stored minute and hour
// buckets, the reset of the raw series on restart, and the settings the tab edits (memory, JVM flags, the performance
// group of server.properties).
// usage: node performance-tab.mjs <base> [mcVersion] [mcPort]   (KEEP_RUNNING=1 leaves the server up for a browser check)
import { client } from "./client.mjs";

const [base = "http://127.0.0.1:8130", mcVersion = "1.21.11", port = "25830"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const s = await c.create({ name: "perf-tab", software: "paper", mcVersion, port: Number(port), memoryMb: 2048, jvmArgs: "-Dfile.encoding=UTF-8" });
await c.waitInstalled(s.id);
await c.start(s.id);

// Sampling runs for every running server, without a dashboard: no WebSocket is open yet.
const t0 = Date.now();
let hist = { samples: [] };
while (Date.now() - t0 < 60_000) {
  await c.sleep(5000);
  hist = await c.call("GET", `/api/servers/${s.id}/metrics`);
  if (hist.samples.some((m) => m.tps !== null && m.cpuPercent !== null && m.memoryBytes !== null)) break;
}
let last = hist.samples[hist.samples.length - 1];
console.log("last sample:", JSON.stringify(last));
ok(hist.range === "1h" && hist.samples.length >= 2 && hist.samples.every((m, i, a) => i === 0 || m.ts >= a[i - 1].ts), `sampled without a dashboard: ${hist.samples.length} ordered samples`);
ok(last.tps > 0 && last.tps <= 20 && last.mspt > 0 && last.cpuPercent >= 0 && last.memoryBytes > 100e6, `tps ${last.tps}, mspt ${last.mspt}, cpu ${last.cpuPercent}%, rss ${(last.memoryBytes / 1e6).toFixed(0)} MB`);

// A dashboard gets the same samples live.
const { cookie } = c.session();
const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/ws", { headers: { cookie, origin: base } });
const live = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "metrics") live.push(m.metrics);
};
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error("websocket failed")))));
ws.send(JSON.stringify({ type: "subscribe", serverId: s.id }));
await c.sleep(12_000);
hist = await c.call("GET", `/api/servers/${s.id}/metrics`);
last = hist.samples[hist.samples.length - 1];
const kept = new Set(hist.samples.map((m) => m.ts));
ok(live.length >= 2 && live.every((m) => kept.has(m.ts)), `the live stream delivered samples the history also has (${live.length})`);

// Stored history: minute buckets for a day, hour buckets beyond. Wait until a finished minute was written.
const ranged = await c.call("GET", `/api/servers/${s.id}/metrics?range=2y`).then(() => false, (e) => e.status === 400);
ok(ranged, "an unknown range is refused");
let day = { buckets: [] };
const t1 = Date.now();
while (Date.now() - t1 < 150_000) {
  day = await c.call("GET", `/api/servers/${s.id}/metrics?range=24h`);
  if (day.buckets.filter((b) => b.tpsAvg !== null && b.cpuAvg !== null && b.memoryAvg !== null).length >= 2) break;
  await c.sleep(10_000);
}
const full = day.buckets.filter((b) => b.tpsAvg !== null && b.cpuAvg !== null && b.memoryAvg !== null);
console.log("minute bucket:", JSON.stringify(full[0]));
ok(day.resolutionMs === 60_000 && full.length >= 2 && full.every((b) => b.ts % 60_000 === 0 && b.tpsMin <= b.tpsAvg && b.cpuMax >= b.cpuAvg && b.memoryMax >= b.memoryAvg), `24 h: ${day.buckets.length} minute buckets with averages and extremes`);
const week = await c.call("GET", `/api/servers/${s.id}/metrics?range=7d`);
ok(week.resolutionMs === 3_600_000 && week.buckets.length >= 1 && week.buckets.length <= 2 && week.buckets.every((b) => b.ts % 3_600_000 === 0 && b.cpuAvg !== null), `7 d: ${week.buckets.length} hour bucket(s)`);

// The settings behind the tab.
const perf = await c.call("GET", `/api/servers/${s.id}/performance`);
ok(perf.fit && perf.presets.length === 3 && perf.current === null, `performance info: fit "${perf.fit.headline}", custom settings, distances ${perf.viewDistance ?? "default"}/${perf.simulationDistance ?? "default"}`);
const patched = await c.call("PATCH", `/api/servers/${s.id}`, { memoryMb: 3072, jvmArgs: "-Dfile.encoding=UTF-8 -XX:+UseG1GC" });
ok(patched.memoryMb === 3072 && patched.jvmArgs.includes("-XX:+UseG1GC") && patched.restartRequired, "memory and JVM arguments saved on their own, restart required");
await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { "view-distance": "8", "max-tick-time": "-1" } });
const props = (await c.call("GET", `/api/servers/${s.id}/properties`)).values;
ok(props["view-distance"] === "8" && props["max-tick-time"] === "-1", "performance properties saved");
const rejected = await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { "view-distance": "99" } }).then(() => false, (e) => e.status === 400);
ok(rejected, "an out-of-range distance is refused");

// A restart starts a new series.
hist = await c.call("GET", `/api/servers/${s.id}/metrics`);
last = hist.samples[hist.samples.length - 1];
const before = hist.samples.length;
await c.call("POST", `/api/servers/${s.id}/restart`);
await c.sleep(4000);
await c.waitStatus(s.id, "running");
await c.sleep(6000);
const again = await c.call("GET", `/api/servers/${s.id}/metrics`);
ok(again.samples.length > 0 && again.samples.length < before + 3 && again.samples[0].ts > last.ts, `restart began a fresh history (${again.samples.length} samples, was ${before})`);
ok((await c.server(s.id)).memoryMb === 3072, "memory applied on restart");

ws.close();
if (!process.env.KEEP_RUNNING) await c.stop(s.id);
console.log(process.exitCode ? "FAILED" : "all checks passed", process.env.KEEP_RUNNING ? `(server ${s.id} left running)` : "");
