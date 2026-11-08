// Start; on a crash, show CraftPanel's error and disable the mods NeoForge blames (client-only mods a pack marks as server-side).
import { client } from "./client.mjs";
const [base] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const s = (await c.call("GET", "/api/servers")).find((x) => x.name.startsWith("mp-Create"));
const seen = new Set();
for (let round = 0; round < 10; round++) {
  try {
    await c.start(s.id);
    console.log("RUNNING after round", round);
    await c.stop(s.id);
    break;
  } catch (e) {
    console.log("round", round, "start failed:", (await c.server(s.id)).lastError);
  }
  const log = await c.log(s.id);
  const text = (log?.lines ?? log ?? []).map((l) => l.text);
  const bad = [...new Set(text.flatMap((l) => [...l.matchAll(/-- Mod loading issue for: ([A-Za-z0-9_.-]+) --/g)].map((m) => m[1])))].filter((id) => !seen.has(id));
  bad.forEach((id) => seen.add(id));
  if (!bad.length) break;
  const res = await c.call("GET", `/api/servers/${s.id}/plugins`);
  const mods = Array.isArray(res) ? res : res.plugins;
  for (const id of bad) {
    const m = mods.find((p) => p.main === id && p.enabled);
    if (m) {
      await c.call("PATCH", `/api/servers/${s.id}/plugins/${encodeURIComponent(m.file)}`, { enabled: false });
      console.log("disabled", m.file, `(${m.name} ${m.version})`);
    } else console.log("not in the mod list:", id);
  }
}
