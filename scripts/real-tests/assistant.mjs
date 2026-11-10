// The AI assistant against a real Paper server, with a scripted OpenAI-compatible "model" on localhost (no key, no
// network). It checks status, waits for approval before a console command and a whitelist change, runs them on the
// real server, and shows the console output in the conversation.
//   scripts/real-tests/run.sh <port> <data-dir> assistant.mjs [mc-port] [model-port]
// With KEEP_OPEN=1 the instance stays up after the checks (for a look at the dashboard) until Ctrl+C.
import http from "node:http";
import fs from "node:fs";
import { client } from "./client.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:8140";
const mcPort = Number(process.argv[3] ?? 25894);
const modelPort = Number(process.argv[4] ?? 11501);
const c = client(base);
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

// A rule-based stand-in for a model: it reads the last message and answers like a tool-calling model would.
const seen = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { messages, tools } = JSON.parse(body);
    seen.push({ messages, tools: tools.map((t) => t.function.name) });
    const last = messages.at(-1);
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const call = (name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `call_${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    const say = (text) => ({ choices: [{ finish_reason: "stop", message: { content: text } }] });
    let reply;
    if (last.role === "tool") {
      const out = last.content;
      reply = say(/declined/i.test(out) ? "Okay, I did not do it." : `Done. Result: ${out.slice(0, 300)}`);
    } else if (/status/i.test(user)) reply = call("server_status", {});
    else if (/whitelist (\w+)/i.test(user)) reply = call("player_action", { action: "whitelist-add", player: /whitelist (\w+)/i.exec(user)[1] });
    else if (/ban (\w+)/i.test(user)) reply = call("player_action", { action: "ban", player: /ban (\w+)/i.exec(user)[1], reason: "test" });
    else if (/who is online/i.test(user)) reply = call("run_command", { command: "list" });
    else reply = say("I can check status, run commands and manage players.");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => model.listen(modelPort, "127.0.0.1", r));

await c.signIn();
await c.call("PUT", "/api/assistant/settings", {
  enabled: true, provider: "openai-compatible", model: "scripted", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "",
  approval: "always", toolGroups: ["servers", "console", "players", "plugins", "backups", "schedules", "settings"], minRole: "operator", maxSteps: 6, instructions: "",
});
const test = await c.call("POST", "/api/assistant/settings/test", (await c.call("GET", "/api/assistant/settings")));
ok(test.ok, `connection test answers (${test.reply})`);

const s = await c.create({ name: "assistant", software: "paper", mcVersion: "1.21.4", port: mcPort, memoryMb: 1024 });
await c.waitInstalled(s.id);
await c.start(s.id);

const settle = async (id) => {
  for (let i = 0; i < 100; i++) {
    const v = await c.call("GET", `/api/assistant/conversations/${id}`);
    if (v.status !== "running") return v;
    await c.sleep(200);
  }
  throw new Error("assistant did not settle");
};
const ask = async (message, conversationId) => settle((await c.call("POST", "/api/assistant/conversations", { message, serverId: s.id, conversationId })).id);
const lastTool = (v) => v.items.filter((i) => i.kind === "tool").at(-1);

let v = await ask("What's the status of this server?");
ok(lastTool(v)?.state === "done" && /"status":"running"/.test(lastTool(v).result ?? ""), `status is read without approval (${lastTool(v)?.state})`);
ok(/^Done/.test(v.items.at(-1).text ?? ""), "the model gets the result and answers");
ok(!seen[0].tools.includes("write_file"), "file tools are not offered when switched off");

v = await ask("Who is online?", v.id);
ok(v.status === "awaiting" && lastTool(v).state === "waiting" && lastTool(v).title === 'Run "list" on assistant', `a console command waits for approval (${v.status})`);
v = await c.call("POST", `/api/assistant/conversations/${v.id}/decision`, { toolCallId: lastTool(v).id, approve: true });
v = await settle(v.id);
ok(lastTool(v).state === "done" && /There are 0 of a max of \d+ players online/.test(lastTool(v).result ?? ""), `approved command ran on the real server: ${lastTool(v).result}`);

v = await ask("Please whitelist Alex", v.id);
v = await c.call("POST", `/api/assistant/conversations/${v.id}/decision`, { toolCallId: lastTool(v).id, approve: true });
v = await settle(v.id);
ok(lastTool(v).state === "done", `whitelist change approved and done (${lastTool(v).state})`);
const players = await c.call("GET", `/api/servers/${s.id}/players`);
ok(players.whitelist.some((w) => w.name === "Alex"), "Alex is on the server's whitelist");

v = await ask("ban Steve", v.id);
v = await c.call("POST", `/api/assistant/conversations/${v.id}/decision`, { toolCallId: lastTool(v).id, approve: false });
v = await settle(v.id);
ok(lastTool(v).state === "rejected" && v.items.at(-1).text === "Okay, I did not do it.", "a declined ban is not run and the model is told");
ok(!(await c.call("GET", `/api/servers/${s.id}/players`)).bans.some((b) => b.name === "Steve"), "Steve is not banned");

const audit = await c.call("GET", "/api/audit?limit=50");
const rows = Array.isArray(audit) ? audit : audit.entries ?? audit.items ?? [];
ok(rows.some((a) => a.username === "owner (AI assistant)" && a.action === "console.command"), "the command is in the audit log as owner (AI assistant)");

if (process.env.KEEP_OPEN) {
  fs.writeFileSync(process.env.KEEP_OPEN, JSON.stringify({ serverId: s.id }));
  console.log(`Instance open at ${base} (owner / owner-password-1). Ctrl+C to stop.`);
  await new Promise(() => {});
}
await c.stop(s.id);
model.close();
