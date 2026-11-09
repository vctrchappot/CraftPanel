// The Performance tab's data on a real server: metric history from the live sampling, its reset on restart, and
// the settings the tab edits (memory, JVM flags, the performance group of server.properties).
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

// Sampling only runs while a dashboard is subscribed, exactly like the browser does it.
const { cookie } = c.session();
const ws = new WebSocket(base.replace(/^http/, "ws") + "/api/ws", { headers: { cookie, origin: base } });
const live = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "metrics") live.push(m.metrics);
};
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error("websocket failed")))));
ws.send(JSON.stringify({ type: "subscribe", serverId: s.id }));

const t0 = Date.now();
let hist = { samples: [] };
while (Date.now() - t0 < 60_000) {
  await c.sleep(5000);
  hist = await c.call("GET", `/api/servers/${s.id}/metrics`);
  if (hist.samples.some((m) => m.tps !== null && m.cpuPercent !== null && m.memoryBytes !== null)) break;
}
const last = hist.samples[hist.samples.length - 1];
console.log("last sample:", JSON.stringify(last));
ok(hist.samples.length >= 2 && hist.samples.every((m, i, a) => i === 0 || m.ts >= a[i - 1].ts), `history has ${hist.samples.length} ordered samples`);
ok(last.tps > 0 && last.tps <= 20 && last.mspt > 0 && last.cpuPercent >= 0 && last.memoryBytes > 100e6, `tps ${last.tps}, mspt ${last.mspt}, cpu ${last.cpuPercent}%, rss ${(last.memoryBytes / 1e6).toFixed(0)} MB`);
ok(live.length >= hist.samples.length - 1, `the live stream delivered the same samples (${live.length})`);

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
