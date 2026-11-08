import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of services.splice(0)) await s.close(2000);
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

describe("independent runtime transport", () => {
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
