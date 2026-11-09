import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeReporter } from "../src/diagnostics";
import { RuntimeClient, RuntimeService, runtimePaths, RUNTIME_PROTOCOL, channel } from "../src/index";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-minecraft.mjs");
const spec = { javaPath: "unused", directory: os.tmpdir(), jarFile: "unused", memoryMb: 512, jvmArgs: [], software: "vanilla" as const,
  command: { file: process.execPath, args: [fake, "normal"] } };
const roots: string[] = [];
const services: RuntimeService[] = [];
const clients: RuntimeClient[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-ipc-"));
  roots.push(dir);
  const runtime = new RuntimeService(dir);
  services.push(runtime);
  await runtime.listen();
  const client = new RuntimeClient(dir);
  clients.push(client);
  await client.connect();
  return { dir, runtime, client };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of services.splice(0)) await s.close(2000);
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

describe("independent runtime transport", () => {
  it("bounds diagnostic output and never includes error messages or credentials", () => {
    const sink = vi.fn();
    const report = runtimeReporter("service", sink);
    for (let i = 0; i < 25; i++) report("registry-write-failed", Object.assign(new Error("secret-token-and-command"), { code: "EACCES" }));
    expect(sink).toHaveBeenCalledTimes(10);
    expect(sink.mock.calls[0][0]).toEqual({ component: "service", reason: "registry-write-failed", code: "EACCES" });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("secret-token");
  });

  it("reports registry persistence failure and lets every close caller await cleanup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-ipc-"));
    roots.push(dir);
    const diagnostics = vi.fn();
    const runtime = new RuntimeService(dir, "test", diagnostics);
    await runtime.listen();
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("private-path"), { code: "EACCES" }));
    runtime.agent.setStatus("test", "error");
    await expect.poll(() => diagnostics.mock.calls.some(([entry]) => entry.reason === "registry-write-failed")).toBe(true);
    const closing = runtime.close(2000);
    expect(runtime.close(2000)).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: "EACCES" });
    expect(diagnostics.mock.calls).toContainEqual([{ component: "service", reason: "registry-write-failed", code: "EACCES" }]);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("rejects an in-flight query on IPC loss and reconnects without replaying it", async () => {
    const { dir, runtime } = await fixture();
    // A real local relay makes transport loss independent of dashboard or service shutdown.
    const relayDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-ipc-relay-"));
    roots.push(relayDir);
    const relayPaths = runtimePaths(relayDir);
    await fs.mkdir(relayPaths.directory);
    await fs.copyFile(runtimePaths(dir).token, relayPaths.token);
    const sockets = new Set<net.Socket>();
    const relay = net.createServer((downstream) => {
      const upstream = net.connect(runtimePaths(dir).endpoint);
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
      }
      downstream.pipe(upstream).pipe(downstream);
    });
    await new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.listen(relayPaths.endpoint, resolve); });
    const next = new RuntimeClient(relayDir, () => undefined);
    clients.push(next);
    try {
      await next.connect();
      await next.start("test", spec);
      await expect.poll(() => next.status("test")).toBe("running");
      const pid = next.info("test").pid;
      const query = vi.spyOn(runtime.agent, "query");
      const pending = next.query("test", "unanswered-command", /no-such-response/, { timeoutMs: 1500 });
      const rejected = expect(pending).rejects.toThrow(/unavailable/);
      await expect.poll(() => query.mock.calls.length).toBe(1);
      for (const socket of sockets) socket.destroy();
      await rejected;
      expect(next.status("test")).toBe("unknown");
      await expect.poll(() => next.connected, { timeout: 5000 }).toBe(true);
      expect(next.info("test").pid).toBe(pid);
      await next.query("test", "save-all flush", /^Saved the (game|world)/);
      expect(query.mock.calls.filter(([, command]) => command === "unanswered-command")).toHaveLength(1);
      expect(await next.stop("test", 2000)).toBe(true);
    } finally {
      await next.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("keeps the same process and full control after the dashboard disconnects", async () => {
    const { dir, runtime, client } = await fixture();
    await client.start("test", spec);
    await expect.poll(() => client.status("test")).toBe("running");
    const pid = client.info("test").pid;
    await client.send("test", "join Steve");
    await expect.poll(() => client.info("test").players.length).toBe(1);
    await client.disconnect();
    expect(runtime.agent.isRunning("test")).toBe(true);
    const next = new RuntimeClient(dir);
    clients.push(next);
    await next.connect();
    expect(next.status("test")).toBe("running");
    expect(next.info("test").pid).toBe(pid);
    expect(next.info("test").players[0].name).toBe("Steve");
    expect(next.history("test").some((l) => l.text.includes("Done"))).toBe(true);
    const result = await next.query("test", "save-all flush", /^Saved the (game|world)/);
    expect(result?.[1]).toBe("game");
    expect(await next.stop("test", 2000)).toBe(true);
  });

  it("rejects a duplicate start at the process owner", async () => {
    const { client } = await fixture();
    await client.start("test", spec);
    const pid = client.info("test").pid;
    await expect(client.start("test", spec)).rejects.toThrow(/already running/);
    expect(client.info("test").pid).toBe(pid);
  });

  it("fails closed while disconnected instead of queuing commands", async () => {
    const { client } = await fixture();
    await client.disconnect();
    expect(client.status("test")).toBe("unknown");
    expect(() => client.isRunning("test")).toThrow(/unavailable/);
    await expect(client.send("test", "stop")).rejects.toThrow(/unavailable/);
  });

  it("restores autosave when the dashboard disappears during a live backup", async () => {
    const { runtime, client } = await fixture();
    await client.start("test", spec);
    await expect.poll(() => client.status("test")).toBe("running");
    const send = vi.spyOn(runtime.agent, "send");
    await client.send("test", "save-off");
    await client.disconnect();
    await expect.poll(() => send.mock.calls.some(([id, command]) => id === "test" && command === "save-on")).toBe(true);
    expect(runtime.agent.isRunning("test")).toBe(true);
  });

  it("refuses wrong credentials and incompatible protocol versions", async () => {
    const { dir } = await fixture();
    const paths = runtimePaths(dir);
    const token = (await fs.readFile(paths.token, "utf8")).trim();
    for (const hello of [{ protocol: RUNTIME_PROTOCOL, token: "0".repeat(64) }, { protocol: RUNTIME_PROTOCOL + 1, token }]) {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(paths.endpoint);
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("unauthenticated peer stayed open")); }, 4000);
        socket.on("error", () => undefined);
        socket.on("connect", () => socket.write(JSON.stringify({ type: "hello", ...hello }) + "\n"));
        socket.on("data", () => reject(new Error("unauthenticated peer received state")));
        socket.on("close", () => { clearTimeout(timer); resolve(); });
      });
    }
  });

  it("rejects expired commands and closes on replayed sequence numbers", async () => {
    const { dir, runtime, client } = await fixture();
    await client.start("test", spec);
    await expect.poll(() => client.status("test")).toBe("running");
    const paths = runtimePaths(dir);
    const token = (await fs.readFile(paths.token, "utf8")).trim();
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(paths.endpoint);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("replay test timed out")); }, 4000);
      socket.on("error", () => undefined);
      const send = channel(socket, (m) => {
        if (m.type === "ready") {
          const call = { type: "call", session: m.session, epoch: m.epoch, seq: 1, method: "send", id: "test", command: "stop", deadline: Date.now() - 1 };
          send(call);
        } else if (m.type === "reply") {
          expect(m.error).toMatch(/expired/);
          send({ type: "call", seq: 1, method: "send", id: "test", command: "stop", deadline: Date.now() + 5000 });
        }
      });
      socket.on("connect", () => send({ type: "hello", protocol: RUNTIME_PROTOCOL, token }));
      socket.on("close", () => { clearTimeout(timer); resolve(); });
    });
    expect(runtime.agent.isRunning("test")).toBe(true);
  });

  it("stops gracefully on runtime shutdown and restores auto-start on its next boot", async () => {
    const { dir, runtime, client } = await fixture();
    await client.start("test", { ...spec, autoStart: true });
    await expect.poll(() => client.status("test")).toBe("running");
    const pid = client.info("test").pid;
    await client.disconnect();
    await runtime.close(2000);
    expect(runtime.agent.status("test")).toBe("stopped");
    const next = new RuntimeService(dir);
    services.push(next);
    await next.listen();
    await expect.poll(() => next.agent.status("test")).toBe("running");
    expect(next.agent.info("test").pid).not.toBe(pid);
  });

  it("persists updated boot policy without starting a server", async () => {
    const { dir, runtime, client } = await fixture();
    await client.configure("test", { ...spec, autoStart: true });
    expect(client.owns("test")).toBe(true);
    expect(client.isRunning("test")).toBe(false);
    await client.disconnect();
    await runtime.close(2000);
    const next = new RuntimeService(dir);
    services.push(next);
    await next.listen();
    await expect.poll(() => next.agent.status("test")).toBe("running");
  });
});
