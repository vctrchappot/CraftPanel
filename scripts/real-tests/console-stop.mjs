// `stop` and `restart` typed in the console are a shutdown, not a crash; `restart` brings the server back up.
//   scripts/real-tests/run.sh <port> <data-dir> console-stop.mjs [mc-port]
import { client } from "./client.mjs";

const c = client(process.argv[2] ?? "http://127.0.0.1:8130");
const mcPort = Number(process.argv[3] ?? 25893);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const events = async (id) => (await c.call("GET", `/api/servers/${id}/activity?limit=30`).catch(() => null)) ?? [];

const s = await c.create({ name: "console-stop", software: "paper", mcVersion: "1.21.4", port: mcPort, memoryMb: 1024 });
await c.waitInstalled(s.id);

await c.start(s.id);
await c.command(s.id, "stop");
let d = await c.waitStatus(s.id, "stopped", 120_000);
ok(d.status === "stopped" && !d.lastError, `console "stop" → stopped, no error (${d.status}, ${d.lastError ?? "no error"})`);

await c.start(s.id);
const pid1 = (await c.server(s.id)).pid;
await c.command(s.id, "restart");
// stopped (expected) and then started again by CraftPanel
await c.waitStatus(s.id, "stopped", 120_000).catch(() => null);
d = await c.waitStatus(s.id, "running", 240_000);
ok(d.status === "running" && d.pid && d.pid !== pid1, `console "restart" → running again with a new process (pid ${pid1} → ${d.pid})`);
await c.stop(s.id);
const log = JSON.stringify(await c.log(s.id));
ok(!/Server crashed/.test(log), "no \"Server crashed\" line in the console");
