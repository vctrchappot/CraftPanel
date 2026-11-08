import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { eq, servers } from "@craftpanel/database";
import { dataLayout, RuntimeClient, RuntimeService } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { loadConfig } from "../src/config";

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
