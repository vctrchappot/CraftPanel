// Upload path: a vanilla .mrpack whose overrides bring server.properties and eula.txt, plus a Forge pack that must be refused.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { client } from "./client.mjs";
const [base, port] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const make = (name, index, files) => {
  const dir = `/tmp/${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/modrinth.index.json`, JSON.stringify(index));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(`${dir}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true });
    fs.writeFileSync(`${dir}/${p}`, text);
  }
  execFileSync("python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])", `/tmp/${name}`, dir]);
  return `/tmp/${name}.zip`;
};
// cp.mjs only sends JSON; reuse its session for a multipart request.
const upload = async (file) => {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(file)]), "pack.mrpack");
  const { cookie, csrf } = c.session();
  const r = await fetch(base + "/api/modpacks/upload", { method: "POST", body: fd, headers: { cookie, "x-csrf-token": csrf } });
  return { status: r.status, body: await r.json() };
};
const forge = make("forge-pack", { formatVersion: 1, game: "minecraft", versionId: "1", name: "Forge Pack", files: [], dependencies: { minecraft: "1.20.1", forge: "47.2.0" } }, {});
console.log("forge:", JSON.stringify(await upload(forge)));
const junk = "/tmp/junk.mrpack";
fs.writeFileSync(junk, "hello");
console.log("junk:", JSON.stringify(await upload(junk)));
const vanilla = make(
  "vanilla-pack",
  { formatVersion: 1, game: "minecraft", versionId: "2.0", name: "Own Pack", summary: "uploaded", files: [], dependencies: { minecraft: "1.21.11" } },
  { "overrides/server.properties": "server-port=9999\nmotd=From the pack\nspawn-protection=0\n", "overrides/eula.txt": "eula=false\n", "overrides/config/a.txt": "common", "server-overrides/config/a.txt": "server", "client-overrides/options.txt": "client" },
);
const up = await upload(vanilla);
console.log("vanilla:", JSON.stringify(up));
const created = await c.create({ name: "own-pack", software: "paper", mcVersion: "x", port: Number(port), modpackId: up.body.id });
console.log("created", created.software, created.mcVersion);
await c.waitInstalled(created.id);
const props = await c.call("GET", `/api/servers/${created.id}/files/content?path=server.properties`).catch((e) => e.message);
console.log("props:", JSON.stringify(props).slice(0, 400));
await c.start(created.id);
console.log("started on", (await c.server(created.id)).port);
await c.stop(created.id);
console.log("reuse after create:", (await c.create({ name: "again", software: "paper", mcVersion: "x", port: Number(port) + 1, modpackId: up.body.id }).catch((e) => e.status)));
