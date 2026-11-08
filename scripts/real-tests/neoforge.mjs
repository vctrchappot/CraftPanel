// NeoForge scenario: catalog, create, install, start, Modrinth mod (Chunky) + pre-generation, mod list, software switch preview.
// usage: node nf.mjs <base> <mcVersion> <port>
import { client } from "./client.mjs";
const [base, mc, port] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const versions = await c.call("GET", "/api/catalog/neoforge/versions");
console.log("versions:", versions.slice(0, 8).map((v) => v.id).join(", "), `(${versions.length})`);
const info = await c.call("GET", `/api/catalog/neoforge/versions/${mc}`);
console.log("builds:", info.builds.slice(0, 3).map((b) => `${b.id} ${b.channel}`).join(", "), "java", info.java.major);
const created = await c.create({ name: `nf-${mc}`, software: "neoforge", mcVersion: mc, port: Number(port), memoryMb: 3072 });
const t1 = Date.now();
const inst = await c.waitInstalled(created.id, 20 * 60_000);
console.log("installed in", Math.round((Date.now() - t1) / 1000), "s", inst.jarFile, inst.build);
const t2 = Date.now();
await c.start(created.id);
console.log("running after", Math.round((Date.now() - t2) / 1000), "s");
const log = await c.log(created.id);
const lines = (log?.lines ?? log ?? []).map((l) => l.text);
console.log(lines.filter((l) => /Starting: |NeoForge|Done \(|ERROR/.test(l)).slice(0, 8).map((l) => l.slice(0, 220)).join("\n"));
const pg = await c.call("POST", `/api/servers/${created.id}/pregen/install`).catch((e) => e.message);
console.log("chunky install:", JSON.stringify(pg));
const modsRes = await c.call("GET", `/api/servers/${created.id}/plugins`);
const mods = Array.isArray(modsRes) ? modsRes : (modsRes.plugins ?? []);
console.log("mods:", JSON.stringify(mods.map((m) => ({ file: m.file, name: m.name, version: m.version, missing: m.missingDependencies }))));
const search = await c.call("GET", `/api/servers/${created.id}/plugins/search?q=ferrite`);
console.log("search:", search.hits.slice(0, 3).map((h) => `${h.title} ${h.compatible}`).join(" | "));
await c.stop(created.id);
await c.start(created.id);
await c.call("POST", `/api/servers/${created.id}/pregen`, { action: "start", radius: 300 });
for (let i = 0; i < 90; i++) {
  await c.sleep(2000);
  const st = await c.call("GET", `/api/servers/${created.id}/pregen`);
  if (st.task?.state === "finished") { console.log("pregen finished", JSON.stringify(st.task)); break; }
  if (i % 10 === 0) console.log("pregen", JSON.stringify(st.task));
}
await c.stop(created.id);
const prev = await c.call("GET", `/api/servers/${created.id}/software/preview?software=fabric&version=${mc}`).catch((e) => e.message);
console.log("switch preview to fabric:", JSON.stringify(prev).slice(0, 500));
console.log("OK", created.id);
