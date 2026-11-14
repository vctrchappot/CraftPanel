import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auditLog, servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import type { AssistantConversationView } from "@craftpanel/shared";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import type { AppConfig } from "../src/config";

// The AI assistant against a scripted model: no network, every provider request is captured.

let root: string;
let ctx: AppContext;
let app: FastifyInstance;
let serverDir: string;
const serverId = crypto.randomUUID();

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const requests: Captured[] = [];
let script: ((req: Captured) => unknown)[] = [];

const fakeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  const req: Captured = { url: request.url, headers, body: JSON.parse((await request.text()) || "{}") };
  requests.push(req);
  const next = script.shift();
  if (!next) return new Response(JSON.stringify({ error: { message: "no scripted reply" } }), { status: 500 });
  const out = next(req);
  if (out instanceof Response) return out;
  // The Anthropic client streams: replay the scripted message as server-sent events.
  if (req.body.stream && (out as { type?: string }).type === "message") return new Response(anthropicEvents(out as AnthropicMessage), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
};

type AnthropicBlock = { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: unknown };
type AnthropicMessage = { content: AnthropicBlock[]; stop_reason: string } & Record<string, unknown>;

/** The Messages API's streaming events for a finished message. */
function anthropicEvents(m: AnthropicMessage) {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", { message: { ...m, content: [], stop_reason: null } });
  m.content.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "thinking") {
      out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      out += ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  return out + ev("message_stop", {});
}

/** A Chat Completions stream: text in pieces, then a tool call whose arguments arrive in two parts. */
const chatEvents = (chunks: object[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

/** An Anthropic Messages API response. */
const claude = (content: unknown[], stop_reason = "end_turn") => () => ({
  id: `msg_${requests.length}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });

interface Session {
  cookie: string;
  csrf: string;
}
const sessions: Record<string, Session> = {};

const call = (s: Session, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });

async function settle(s: Session, id: string): Promise<AssistantConversationView> {
  for (let i = 0; i < 200; i++) {
    const v = (await call(s, "GET", `/api/assistant/conversations/${id}`)).json() as AssistantConversationView;
    if (v.status !== "running") return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("conversation did not settle");
}

async function ask(s: Session, message: string, conversationId?: string) {
  const r = await call(s, "POST", "/api/assistant/conversations", { message, serverId, conversationId });
  expect(r.statusCode, r.body).toBe(200);
  return settle(s, r.json().id);
}

const anthropicSettings = {
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-5-5",
  baseUrl: "",
  apiKey: "sk-ant-test-key",
  approval: "always",
  toolGroups: ["servers", "console", "players", "plugins", "backups", "schedules", "settings"],
  minRole: "operator",
  maxSteps: 6,
  instructions: "Our server is family friendly.",
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-assistant-"));
  const config: AppConfig = {
    profile: "local", serveWeb: false, logFormat: "json", tls: null, host: "127.0.0.1", port: 0, layout: dataLayout(root),
    corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, webDir: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true,
  };
  ctx = await createContext(config, { assistantFetch: fakeFetch });
  app = await buildApp(ctx, { logger: false });
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
  sessions.owner = { cookie: String(setup.headers["set-cookie"]).split(";")[0], csrf: setup.json().csrfToken };
  for (const role of ["operator", "viewer"]) {
    await call(sessions.owner, "POST", "/api/users", { username: role, password: `${role}-password-1`, role });
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: role, password: `${role}-password-1` } });
    sessions[role] = { cookie: String(r.headers["set-cookie"]).split(";")[0], csrf: r.json().csrfToken };
  }
  serverDir = path.join(root, "servers", "survival");
  await fs.mkdir(serverDir, { recursive: true });
  // Offline mode, so player actions derive UUIDs locally instead of asking Mojang (tests stay off the network).
  await fs.writeFile(path.join(serverDir, "server.properties"), "motd=Hello\nmax-players=20\nonline-mode=false\nrcon.password=hunter2\n");
  const now = Date.now();
  await ctx.database.db.insert(servers).values({
    id: serverId, name: "survival", software: "vanilla", mcVersion: "1.21.11", javaMajor: 21, memoryMb: 1024, directory: serverDir, port: 25598,
    installState: "installed", jarFile: "server.jar", createdAt: now, updatedAt: now,
  });
});

afterAll(async () => {
  await app?.close();
  ctx?.database.close();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  script = [];
});

describe("assistant settings", () => {
  it("is off until the owner configures it", async () => {
    const r = await call(sessions.operator, "GET", "/api/assistant");
    expect(r.json()).toMatchObject({ enabled: false, available: false });
    const send = await call(sessions.operator, "POST", "/api/assistant/conversations", { message: "hi" });
    expect(send.statusCode).toBe(403);
  });

  it("only lets the owner change settings, and never returns the key", async () => {
    expect((await call(sessions.operator, "PUT", "/api/assistant/settings", anthropicSettings)).statusCode).toBe(403);
    const r = await call(sessions.owner, "PUT", "/api/assistant/settings", anthropicSettings);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().apiKey).toBe("••••••••");
    expect((await call(sessions.owner, "GET", "/api/settings")).body).not.toContain("sk-ant-test-key");
    // Saving the redacted placeholder keeps the stored key.
    await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, apiKey: "••••••••" });
    expect((await ctx.assistant.config()).apiKey).toBe("sk-ant-test-key");
    const audit = await ctx.database.db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain("sk-ant-test-key");
  });

  it("requires a base URL for OpenAI-compatible providers", async () => {
    const r = await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, provider: "openai-compatible", baseUrl: "" });
    expect(r.statusCode).toBe(400);
  });

  it("honours the minimum role", async () => {
    expect((await call(sessions.operator, "GET", "/api/assistant")).json().available).toBe(true);
    const viewer = (await call(sessions.viewer, "GET", "/api/assistant")).json();
    expect(viewer.available).toBe(false);
    expect(viewer.reason).toContain("Operator");
  });

  it("tests the connection with the stored key", async () => {
    script = [claude([{ type: "text", text: "Hello!" }])];
    const r = await call(sessions.owner, "POST", "/api/assistant/settings/test", { ...anthropicSettings, apiKey: "••••••••" });
    expect(r.json()).toEqual({ ok: true, reply: "Hello!" });
    expect(requests[0].headers.authorization).toBe("Bearer sk-ant-test-key");
  });
});

describe("assistant conversations (Anthropic)", () => {
  it("runs read tools on its own and sends the results back", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    script = [claude([thinking, toolUse("t1", "read_properties", {})], "tool_use"), claude([{ type: "text", text: "Max players is 20." }])];
    const v = await ask(sessions.operator, "How many players fit?");
    expect(v.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(v.items[1]).toMatchObject({ kind: "tool", name: "read_properties", state: "done", risk: "read" });

    const first = requests[0];
    expect(first.url).toContain("/v1/messages");
    expect(first.body.model).toBe("claude-opus-5-5");
    expect(first.body.fallbacks).toBe("default");
    expect(first.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(String(first.body.system)).toContain("survival");
    expect(String(first.body.system)).toContain("family friendly");
    // Settings tools are offered; file tools are switched off.
    const names = (first.body.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("update_properties");
    expect(names).not.toContain("write_file");

    // The thinking block goes back unchanged, followed by the tool result; secrets stay out.
    const msgs = requests[1].body.messages as { role: string; content: unknown }[];
    expect(msgs[1]).toEqual({ role: "assistant", content: [thinking, toolUse("t1", "read_properties", {})] });
    const result = (msgs[2].content as { type: string; content: string }[])[0];
    expect(result.type).toBe("tool_result");
    expect(result.content).toContain("max-players");
    expect(result.content).not.toContain("hunter2");
  });

  it("waits for approval before a change and runs it as the user", async () => {
    script = [claude([toolUse("t2", "player_action", { action: "whitelist-add", player: "Alex" })], "tool_use")];
    const v = await ask(sessions.operator, "Whitelist Alex");
    expect(v.status).toBe("awaiting");
    expect(v.items.at(-1)).toMatchObject({ kind: "tool", state: "waiting", title: "Add Alex to the whitelist of survival" });
    await expect(fs.readFile(path.join(serverDir, "whitelist.json"), "utf8")).rejects.toThrow();

    script = [claude([{ type: "text", text: "Alex is on the whitelist." }])];
    const d = await call(sessions.operator, "POST", `/api/assistant/conversations/${v.id}/decision`, { toolCallId: "t2", approve: true });
    expect(d.statusCode, d.body).toBe(200);
    const done = await settle(sessions.operator, v.id);
    expect(done.items.find((i) => i.kind === "tool")).toMatchObject({ state: "done" });
    expect(await fs.readFile(path.join(serverDir, "whitelist.json"), "utf8")).toContain("Alex");
    const audit = await ctx.database.db.select().from(auditLog);
    expect(audit.some((a) => a.username === "operator (AI assistant)")).toBe(true);
  });

  it("tells the model when the user declines", async () => {
    script = [claude([toolUse("t3", "player_action", { action: "ban", player: "Griefer", reason: "tnt" })], "tool_use")];
    const v = await ask(sessions.operator, "Ban Griefer");
    script = [claude([{ type: "text", text: "Okay, I left Griefer alone." }])];
    await call(sessions.operator, "POST", `/api/assistant/conversations/${v.id}/decision`, { toolCallId: "t3", approve: false });
    const done = await settle(sessions.operator, v.id);
    expect(done.items.find((i) => i.kind === "tool")).toMatchObject({ state: "rejected" });
    const last = (requests.at(-1)!.body.messages as { content: { content: string; is_error: boolean }[] }[]).at(-1)!;
    expect(last.content[0]).toMatchObject({ is_error: true });
    expect(last.content[0].content).toContain("declined");
    expect(await fs.readFile(path.join(serverDir, "banned-players.json"), "utf8").catch(() => "")).not.toContain("Griefer");
  });

  it("refuses tools beyond the user's permissions without asking", async () => {
    // Operators may not grant Minecraft operator (needs server.configure).
    script = [claude([toolUse("t4", "player_action", { action: "op", player: "Alex" })], "tool_use"), claude([{ type: "text", text: "You can't do that." }])];
    const v = await ask(sessions.operator, "Op Alex");
    expect(v.status).toBe("idle");
    expect(v.items.find((i) => i.kind === "tool")).toMatchObject({ state: "failed" });
    expect((requests[1].body.messages as { content: { content: string }[] }[]).at(-1)!.content[0].content).toContain("server.configure");
  });

  it("only shows a conversation to the user who started it", async () => {
    script = [claude([{ type: "text", text: "Hi" }])];
    const v = await ask(sessions.operator, "Hello");
    expect((await call(sessions.owner, "GET", `/api/assistant/conversations/${v.id}`)).statusCode).toBe(404);
    expect((await call(sessions.operator, "GET", "/api/assistant/conversations")).json().some((c: { id: string }) => c.id === v.id)).toBe(true);
  });

  it("shows provider errors without the key", async () => {
    script = [() => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } })];
    const v = await ask(sessions.operator, "Hello");
    expect(v.items.at(-1)).toMatchObject({ kind: "error" });
    expect((v.items.at(-1) as { text: string }).text).toContain("rejected the API key");
  });
});

describe("assistant conversations (OpenAI-compatible)", () => {
  it("speaks the Chat Completions format", async () => {
    await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, provider: "openai-compatible", baseUrl: "http://localhost:11434/v1/", apiKey: "", model: "llama3.3", approval: "risky" });
    script = [
      () => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_backup", arguments: '{"note":"before update"}' } }] } }] }),
      () => ({ choices: [{ finish_reason: "stop", message: { content: "Backup started." } }] }),
    ];
    const v = await ask(sessions.operator, "Back it up");
    // "risky" approval: a backup is routine and runs at once.
    expect(v.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(v.items[1]).toMatchObject({ state: "done", title: "Back up survival" });
    expect(requests[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0].headers.authorization).toBeUndefined();
    const msgs = requests[1].body.messages as { role: string; tool_call_id?: string }[];
    expect(msgs[0].role).toBe("system");
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    await new Promise((r) => setTimeout(r, 300)); // let the background backup finish before cleanup
  });
});

describe("assistant providers", () => {
  it("sends no empty tools array when testing a Chat Completions provider", async () => {
    script = [() => ({ choices: [{ finish_reason: "stop", message: { content: "Hi there." } }] })];
    const r = await call(sessions.owner, "POST", "/api/assistant/settings/test", { ...anthropicSettings, provider: "openai", model: "gpt-test", apiKey: "sk-openai" });
    expect(r.json()).toEqual({ ok: true, reply: "Hi there." });
    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].body).not.toHaveProperty("tools");
  });

  it("never sends the saved key to a different provider", async () => {
    await call(sessions.owner, "PUT", "/api/assistant/settings", anthropicSettings);
    script = [() => ({ data: [] })];
    await call(sessions.owner, "POST", "/api/assistant/settings/models", { ...anthropicSettings, provider: "deepseek", apiKey: "••••••••" });
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("lists chat models from the provider", async () => {
    script = [() => ({ object: "list", data: [{ id: "models/gemini-pro-test" }, { id: "text-embedding-004" }, { id: "models/gemini-flash-test" }] })];
    const r = await call(sessions.owner, "POST", "/api/assistant/settings/models", { ...anthropicSettings, provider: "gemini", model: "", apiKey: "AIza-test" });
    expect(r.json()).toEqual({ models: ["gemini-flash-test", "gemini-pro-test"] });
    expect(requests[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
    expect(requests[0].headers.authorization).toBe("Bearer AIza-test");
  });

  it("lists Anthropic models", async () => {
    script = [() => ({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" })];
    const r = await call(sessions.owner, "POST", "/api/assistant/settings/models", { ...anthropicSettings, apiKey: "••••••••" });
    expect(r.json()).toEqual({ models: ["claude-opus-5-5"] });
    expect(requests[0].url).toContain("https://api.anthropic.com/v1/models");
  });

  it("explains an address that is not an API", async () => {
    script = [() => new Response("<html>not here</html>", { status: 200, headers: { "content-type": "text/html" } })];
    const r = await call(sessions.owner, "POST", "/api/assistant/settings/models", { ...anthropicSettings, provider: "openai-compatible", baseUrl: "http://localhost:9/", apiKey: "" });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.hint).toMatch(/model list/);
  });

  it("talks to DeepSeek and hands its reasoning back during a tool loop", async () => {
    await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, provider: "deepseek", model: "deepseek-reasoner", apiKey: "sk-deepseek", approval: "risky" });
    script = [
      () => ({ choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_content: "Check the server list first.", tool_calls: [{ id: "d1", type: "function", function: { name: "list_servers", arguments: "{}" } }] } }] }),
      () => ({ choices: [{ finish_reason: "stop", message: { content: "survival is the only server.", reasoning_content: "Done." } }] }),
    ];
    const v = await ask(sessions.operator, "Which servers are there?");
    expect(v.items.at(-1)).toMatchObject({ kind: "assistant", text: "survival is the only server." });
    expect(requests[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(requests[0].headers.authorization).toBe("Bearer sk-deepseek");
    const msgs = requests[1].body.messages as { role: string; reasoning_content?: string }[];
    expect(msgs.find((m) => m.role === "assistant")).toMatchObject({ reasoning_content: "Check the server list first." });
  });
});

describe("assistant streaming and live cards", () => {
  it("reads a streamed Chat Completions answer, tool calls in pieces included, and pushes it live", async () => {
    await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, provider: "openai", model: "gpt-test", apiKey: "sk-openai", approval: "risky" });
    // A fake dashboard socket of the operator, to see what is pushed while the answer is written.
    const user = (await call(sessions.operator, "GET", "/api/auth/state")).json().user;
    const pushed: { type: string; conversation?: AssistantConversationView }[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (d: string) => pushed.push(JSON.parse(d)) };
    const client = { socket, userId: user.id, username: "operator", access: user, sessionId: "s", subscriptions: new Map() } as never;
    ctx.hub.add(client);
    script = [
      () =>
        chatEvents([
          { choices: [{ delta: { content: "Let me " } }] },
          { choices: [{ delta: { content: "look." } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", function: { name: "show_card", arguments: '{"card":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"players"}' } }] }, finish_reason: "tool_calls" }] },
        ]),
      () => chatEvents([{ choices: [{ delta: { content: "Nobody is **online**." }, finish_reason: "stop" }] }]),
    ];
    const v = await ask(sessions.operator, "Who is online?");
    await new Promise((r) => setTimeout(r, 120)); // pushes are batched for 60 ms
    ctx.hub.remove(client);
    expect(requests[0].body.stream).toBe(true);
    expect(v.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(v.items[1]).toEqual({ kind: "assistant", text: "Let me look.", at: expect.any(Number) });
    expect(v.items[2]).toMatchObject({ name: "show_card", state: "done", title: "Show players of survival", embed: { card: "players", serverId, serverName: "survival" } });
    expect(JSON.parse(String((requests[1].body.messages as { role: string; content: string }[]).at(-1)!.content))).toMatchObject({ online: [] });
    expect(v.items[3]).toMatchObject({ text: "Nobody is **online**." });
    // Live pushes reached the user's socket, the last one with the finished conversation.
    const views = pushed.filter((m) => m.type === "assistant").map((m) => m.conversation!);
    expect(views.length).toBeGreaterThan(0);
    expect(views.at(-1)!.items.at(-1)).toMatchObject({ text: "Nobody is **online**." });
  });

  it("shows a viewer a status card", async () => {
    await call(sessions.owner, "PUT", "/api/assistant/settings", { ...anthropicSettings, minRole: "viewer" });
    script = [claude([toolUse("v1", "show_card", { card: "status" })], "tool_use"), claude([{ type: "text", text: "Here it is." }])];
    const v = await ask(sessions.viewer, "How is it?");
    expect(v.items.find((i) => i.kind === "tool")).toMatchObject({ state: "done", embed: { card: "status" } });
  });
});
