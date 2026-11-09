// Host detection and the hardware fit on a real instance: /api/system reports board, effective memory and cores,
// and a server's performance endpoint judges the plan against this machine and the other running servers.
// usage: node host-fit.mjs <base> [mcVersion] [mcPort]
import { client } from "./client.mjs";

const [base = "http://127.0.0.1:8131", mcVersion = "1.21.4", port = "25831"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const sys = await c.call("GET", "/api/system");
ok(sys.cpus >= 1 && sys.memory.total > 0 && sys.memory.total <= sys.memory.physical, `system: ${sys.cpus} cores, ${(sys.memory.total / 1024 ** 3).toFixed(1)} GB usable of ${(sys.memory.physical / 1024 ** 3).toFixed(1)} GB, board ${sys.board ?? "none"}, limited ${sys.memory.limited}`);

const s = await c.create({ name: "fit-small", software: "paper", mcVersion, port: Number(port), memoryMb: 1024, maxPlayers: 10 });
let perf = await c.call("GET", `/api/servers/${s.id}/performance`);
ok(perf.fit && ["good", "tight", "poor"].includes(perf.fit.level), `fit for 10 players with 1 GB: ${perf.fit.level} (${perf.fit.headline})`);
ok(perf.fit.recommendedMemoryMb >= 2048 && perf.fit.notes[0]?.includes("below"), `1 GB is called out as below the recommended ${perf.fit.recommendedMemoryMb} MB`);

await c.call("PATCH", `/api/servers/${s.id}`, { memoryMb: perf.fit.suggestedMemoryMb });
perf = await c.call("GET", `/api/servers/${s.id}/performance`);
ok(!perf.fit.notes.some((n) => n.includes("below")), `after applying the suggestion (${perf.fit.suggestedMemoryMb} MB) the hint is gone: ${perf.fit.level}`);

try {
  await c.call("POST", "/api/servers", { acceptEula: true, name: "fit-huge", software: "paper", mcVersion, port: Number(port) + 1, memoryMb: Math.ceil(sys.memory.total / 1024 / 1024) + 4096 });
  ok(false, "allocating more than the usable memory is refused");
} catch (e) {
  ok(e.status === 400, "allocating more than the usable memory is refused (400)");
}
await c.call("DELETE", `/api/servers/${s.id}`).catch(() => undefined);
