// Modpack scenario: search, prepare from Modrinth, create, install, start, check mods loaded.
// usage: node mp.mjs <base> search <query> | node mp.mjs <base> run <projectId> <port> [versionId]
import { client } from "./client.mjs";
const [base, mode, arg, port, ver] = process.argv.slice(2);
const c = client(base);
await c.signIn();
if (mode === "search") {
  const r = await c.call("GET", `/api/modpacks/search?q=${encodeURIComponent(arg ?? "")}`);
  console.log("total", r.total);
  for (const h of r.hits) console.log(h.id, h.slug, h.downloads, h.versions.slice(-3).join(","));
  process.exit(0);
}
const versions = await c.call("GET", `/api/modpacks/${arg}/versions`);
console.log("versions", versions.length, versions.slice(0, 3).map((v) => `${v.id} ${v.versionNumber} ${v.mcVersions}`));
const t0 = Date.now();
const prepared = await c.call("POST", "/api/modpacks/modrinth", { versionId: ver ?? versions[0].id });
console.log("prepared in", Date.now() - t0, "ms", JSON.stringify(prepared));
const created = await c.create({ name: `mp-${prepared.info.name}`.slice(0, 40), software: "paper", mcVersion: "x", port: Number(port), memoryMb: 3072, modpackId: prepared.id });
console.log("created", created.id, created.software, created.mcVersion, created.build);
const t1 = Date.now();
const inst = await c.waitInstalled(created.id, 30 * 60_000);
console.log("installed in", Math.round((Date.now() - t1) / 1000), "s", inst.jarFile);
const files = await c.call("GET", `/api/servers/${created.id}/files?path=mods`);
console.log("mods dir:", (files.entries ?? files).length, "entries");
const t2 = Date.now();
await c.start(created.id);
console.log("running after", Math.round((Date.now() - t2) / 1000), "s");
const log = await c.log(created.id);
const lines = (log?.lines ?? log ?? []).map((l) => l.text);
console.log(lines.filter((l) => /Loading \d+ mods|Done \(|ERROR|Exception/.test(l)).slice(0, 15).join("\n"));
const acts = await c.call("GET", `/api/servers/${created.id}/activity`).catch(() => null);
console.log(JSON.stringify(acts)?.slice(0, 800));
await c.stop(created.id);
console.log("stopped OK");
