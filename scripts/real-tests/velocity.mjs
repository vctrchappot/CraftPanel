// Velocity proxy with one Paper backend: create, wire, start, and (if mineflayer is installed in the current
// directory's node_modules) join through the proxy and confirm a direct join to the backend is refused.
// usage (via run.sh): velocity.mjs <proxyPort> [paperVersion]   (the backend uses proxyPort + 1)
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, port = "25870", paperVersion = "1.21.4"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const logText = async (id) => {
  const l = await c.log(id);
  return (Array.isArray(l) ? l : (l?.lines ?? [])).map((x) => x.text).join("\n");
};
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const versions = await c.call("GET", "/api/catalog/velocity/versions");
console.log("velocity versions:", versions.slice(0, 3).map((v) => v.id).join(", "));
const proxy = await c.create({ name: "proxy", software: "velocity", mcVersion: versions[0].id, port: Number(port), memoryMb: 512 });
const backend = await c.create({ name: "survival", software: "paper", mcVersion: paperVersion, port: Number(port) + 1 });
await Promise.all([c.waitInstalled(proxy.id), c.waitInstalled(backend.id)]);
console.log("installed proxy and backend");

for (const tab of ["properties", "gamerules"]) ok((await c.call("GET", `/api/servers/${proxy.id}/${tab}`).catch((e) => e)).status === 409, `proxy has no ${tab} (409)`);
const saved = await c.call("PUT", `/api/servers/${proxy.id}/proxy`, { backends: [{ serverId: backend.id, name: "survival" }], onlineMode: false, localOnly: true });
ok(saved.backends[0]?.serverId === backend.id, "backend saved");

await c.start(backend.id);
await c.start(proxy.id);
const overview = await c.call("GET", `/api/servers/${proxy.id}/proxy`);
ok(overview.backends[0]?.setup === "ready", `backend forwarding ready (${overview.backends[0]?.setup})`);
const secret = await c.call("GET", `/api/servers/${proxy.id}/proxy/secret`);
ok(!(await logText(proxy.id)).includes(secret.secret), "secret not in the proxy console");

let mineflayer = null;
try {
  mineflayer = createRequire(path.join(process.cwd(), "noop.js"))("mineflayer");
} catch {
  console.log("SKIP player checks (npm i mineflayer in the current directory to enable them)");
}
if (mineflayer) {
  const join = (p, username) =>
    new Promise((resolve) => {
      const bot = mineflayer.createBot({ host: "127.0.0.1", port: p, username, auth: "offline", version: paperVersion });
      const done = (r) => (bot.end(), resolve(r));
      bot.once("spawn", () => setTimeout(() => done({ spawned: true }), 2000));
      bot.once("kicked", (reason) => done({ kicked: JSON.stringify(reason) }));
      bot.once("error", (e) => done({ error: e.message }));
      setTimeout(() => done({ timeout: true }), 30000);
    });
  const viaProxy = await join(Number(port), "ProxyBot");
  ok(viaProxy.spawned, `bot joins through the proxy ${JSON.stringify(viaProxy)}`);
  await c.sleep(1500);
  ok(/ProxyBot joined the game|ProxyBot\[/.test(await logText(backend.id)), "backend saw the forwarded player");
  const direct = await join(Number(port) + 1, "DirectBot");
  ok(!direct.spawned, `direct join to the backend refused ${JSON.stringify(direct).slice(0, 160)}`);
}

await c.stop(proxy.id);
await c.stop(backend.id);
console.log(process.exitCode ? "FAILED" : "OK");
