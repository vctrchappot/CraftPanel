// Performance presets and Chunky pre-generation on real servers.
// usage: node perf.mjs <base> <software> <version> <port>
import { client } from "./client.mjs";

const [base = "http://127.0.0.1:8130", software = "paper", mcVersion = "1.21.11", port = "25820"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const s = await c.create({ name: `perf-${software}`, software, mcVersion, port: Number(port), memoryMb: 2048, performancePreset: "low-power", jvmArgs: "-Dfile.encoding=UTF-8" });
ok(s.jvmArgs.startsWith("-Dfile.encoding=UTF-8 -XX:+UseG1GC") && !s.jvmArgs.includes("AlwaysPreTouch"), `created with low-power flags: ${s.jvmArgs.slice(0, 80)}…`);
await c.waitInstalled(s.id);
let perf = await c.call("GET", `/api/servers/${s.id}/performance`);
ok(perf.current === "low-power" && perf.viewDistance === 6 && perf.simulationDistance === 4, `detected ${perf.current}, distances ${perf.viewDistance}/${perf.simulationDistance}, recommended ${perf.recommended}`);
await c.start(s.id);
const props = (await c.call("GET", `/api/servers/${s.id}/properties`)).values;
ok(props["view-distance"] === "6" && props["simulation-distance"] === "4", "Minecraft kept view/simulation distance 6/4");

// Switch preset while running: needs a restart.
const after = await c.call("POST", `/api/servers/${s.id}/performance`, { preset: "balanced" });
ok(after.restartRequired && after.jvmArgs.includes("-XX:+AlwaysPreTouch"), "balanced applied, restart required");

// Chunky
let pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
ok(pg.supported && !pg.installed, "pre-generation supported, Chunky not installed yet");
pg = await c.call("POST", `/api/servers/${s.id}/pregen/install`);
ok(pg.installed && pg.restartNeeded, "Chunky installed, restart needed");
const plugins = await c.call("GET", `/api/servers/${s.id}/plugins`);
console.log("addons:", (Array.isArray(plugins) ? plugins : plugins.plugins ?? plugins.items ?? []).map((p) => `${p.name ?? p.file} ${p.version ?? ""}`).join(", "));
await c.call("POST", `/api/servers/${s.id}/restart`);
await c.sleep(4000);
await c.waitStatus(s.id, "running");
perf = await c.call("GET", `/api/servers/${s.id}/performance`);
ok(perf.current === "balanced", `after restart preset ${perf.current}`);
pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
ok(pg.installed && !pg.restartNeeded, "Chunky loaded");
const t0 = Date.now();
await c.call("POST", `/api/servers/${s.id}/pregen`, { action: "start", radius: 500 });
let last = null;
while (Date.now() - t0 < 10 * 60_000) {
  await c.sleep(3000);
  pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
  if (pg.task && JSON.stringify(pg.task) !== JSON.stringify(last)) {
    last = pg.task;
    console.log(`${Math.round((Date.now() - t0) / 1000)}s`, pg.task.state, pg.task.world, pg.task.chunks, `${pg.task.percent}%`, pg.task.eta ?? "", pg.task.rate ?? "");
  }
  if (pg.task?.state === "finished") break;
}
ok(pg.task?.state === "finished" && pg.task.percent === 100, `pre-generation finished: ${pg.task?.chunks} chunks in ${Math.round((Date.now() - t0) / 1000)}s`);
// Pause/continue/cancel on a second, larger task.
await c.call("POST", `/api/servers/${s.id}/pregen`, { action: "start", radius: 3000 });
await c.sleep(6000);
await c.call("POST", `/api/servers/${s.id}/pregen`, { action: "pause" });
await c.sleep(3000);
pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
ok(pg.task?.state === "paused", `pause → ${pg.task?.state} at ${pg.task?.percent}%`);
await c.call("POST", `/api/servers/${s.id}/pregen`, { action: "continue" });
await c.sleep(6000);
pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
ok(pg.task?.state === "running", `continue → ${pg.task?.state} at ${pg.task?.percent}%`);
await c.call("POST", `/api/servers/${s.id}/pregen`, { action: "cancel" });
await c.sleep(3000);
pg = await c.call("GET", `/api/servers/${s.id}/pregen`);
ok(pg.task?.state === "stopped", `cancel → ${pg.task?.state}`);
console.log("server id", s.id);
