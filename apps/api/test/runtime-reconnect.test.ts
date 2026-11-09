import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { eq, servers } from "@craftpanel/database";
import { dataLayout, RuntimeClient, RuntimeService } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { loadConfig } from "../src/config";
import { getProvider } from "@craftpanel/minecraft-providers";

it("reconciles the actual process after dashboard replacement without orphaning or restarting it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-reconnect-"));
  const runtime = new RuntimeService(root);
  const first = new RuntimeClient(root);
  const second = new RuntimeClient(root);
  const config = loadConfig({ CRAFTPANEL_DATA_DIR: root, CRAFTPANEL_PROFILE: "local" }, []);
  config.layout = dataLayout(root);
  let a: Awaited<ReturnType<typeof createContext>> | undefined;
  let b: typeof a;
  try {
    await runtime.listen();
    await first.connect();
    a = await createContext(config, { agent: first });
    await a.database.db.insert(servers).values({ id: "test", name: "Existing world", software: "vanilla", mcVersion: "1.21.1", javaMajor: 21,
      directory: root, memoryMb: 512, port: 25699, installState: "installed", eulaAccepted: true, autoStart: true, createdAt: Date.now(), updatedAt: Date.now() });
    const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server-runtime/test/fake-minecraft.mjs");
    await first.start("test", { javaPath: "unused", directory: root, jarFile: "unused", memoryMb: 512, jvmArgs: [], software: "vanilla", command: { file: process.execPath, args: [fake] } });
    await expect.poll(() => first.status("test")).toBe("running");
    const pid = first.info("test").pid;
    await first.disconnect();
    a.database.close();
    a = undefined;
    await second.connect();
    b = await createContext(config, { agent: second });
    await b.servers.recover();
    expect(b.servers.summary(await b.servers.row("test"))).toMatchObject({ status: "running" });
    expect((await b.servers.row("test")).lastStatus).toBe("running");
    expect(second.info("test").pid).toBe(pid);
    await b.servers.sendCommand("test", "join Steve");
    await expect.poll(() => second.info("test").players.length).toBe(1);
    await b.servers.stop("test", { id: null, username: null, ip: null });
    await b.database.db.update(servers).set({ lastStatus: "running", pid }).where(eq(servers.id, "test"));
    await b.servers.recover();
    expect(second.status("test")).toBe("stopped"); // Dashboard recovery must not rerun auto-start.
    expect((await b.servers.row("test")).lastStatus).toBe("stopped");
  } finally {
    await first.disconnect();
    await second.disconnect();
    await runtime.close(2000);
    a?.database.close();
    b?.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps an active installation intact when the runtime reconnects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-reconnect-install-"));
  const config = loadConfig({ CRAFTPANEL_DATA_DIR: root, CRAFTPANEL_PROFILE: "local" }, []);
  config.layout = dataLayout(root);
  const ctx = await createContext(config);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const java = vi.spyOn(ctx.servers, "ensureJava").mockResolvedValue(process.execPath);
  const install = vi.spyOn(getProvider("vanilla"), "install").mockImplementation(async () => {
    await gate;
    return { jarFile: "server.jar", sha: "test", build: null };
  });
  let installing: Promise<void> | undefined;
  try {
    await ctx.database.db.insert(servers).values({ id: "test", name: "Installing", software: "vanilla", mcVersion: "26.3", javaMajor: 25,
      directory: root, memoryMb: 512, port: 25699, installState: "pending", createdAt: Date.now(), updatedAt: Date.now() });
    installing = ctx.servers.install("test");
    await expect.poll(async () => (await ctx.servers.row("test")).installState).toBe("installing");
    await ctx.servers.recover();
    expect((await ctx.servers.row("test")).installState).toBe("installing");
    release();
    await installing;
    expect((await ctx.servers.row("test")).installState).toBe("installed");
  } finally {
    release();
    await installing;
    java.mockRestore();
    install.mockRestore();
    await ctx.agent.disconnect();
    ctx.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("publishes installation completion only after runtime registration is acknowledged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-install-ready-"));
  const config = loadConfig({ CRAFTPANEL_DATA_DIR: root, CRAFTPANEL_PROFILE: "local" }, []);
  config.layout = dataLayout(root);
  const runtime = new RuntimeService(root);
  const agent = new RuntimeClient(root);
  await runtime.listen();
  await agent.connect();
  const ctx = await createContext(config, { agent });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const configure = agent.configure.bind(agent);
  const registration = vi.spyOn(agent, "configure").mockImplementation(async (...args) => { await gate; await configure(...args); });
  const java = vi.spyOn(ctx.servers, "ensureJava").mockResolvedValue(process.execPath);
  const provider = vi.spyOn(getProvider("vanilla"), "install").mockResolvedValue({ jarFile: "server.jar", sha: "test", build: null });
  let installing: Promise<void> | undefined;
  try {
    await ctx.database.db.insert(servers).values({ id: "test", name: "Installing", software: "vanilla", mcVersion: "26.3", javaMajor: 25,
      directory: root, memoryMb: 512, port: 25699, installState: "pending", eulaAccepted: true, createdAt: Date.now(), updatedAt: Date.now() });
    installing = ctx.servers.install("test");
    await expect.poll(() => registration.mock.calls.length).toBe(1);
    expect((await ctx.servers.row("test")).installState).toBe("installing");
    release();
    await installing;
    expect((await ctx.servers.row("test")).installState).toBe("installed");
    expect(agent.owns("test")).toBe(true);
  } finally {
    release();
    await installing;
    registration.mockRestore(); java.mockRestore(); provider.mockRestore();
    await agent.disconnect();
    await runtime.close();
    ctx.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
