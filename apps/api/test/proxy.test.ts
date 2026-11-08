import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createZip } from "@craftpanel/backup";
import { listPlugins } from "@craftpanel/minecraft-providers";
import { backendAddress, paperHasGlobalConfig } from "../src/services/proxy";

describe("proxy helpers", () => {
  it("reaches backends on their bind address or on this machine", () => {
    expect(backendAddress({ bindAddress: "", port: 25871 })).toBe("127.0.0.1:25871");
    expect(backendAddress({ bindAddress: "0.0.0.0", port: 25871 })).toBe("127.0.0.1:25871");
    expect(backendAddress({ bindAddress: "192.168.1.20", port: 25871 })).toBe("192.168.1.20:25871");
    expect(backendAddress({ bindAddress: "fd00::5", port: 25871 })).toBe("[fd00::5]:25871");
  });
  it("knows which Paper versions keep Velocity settings in paper-global.yml", () => {
    expect(paperHasGlobalConfig("1.19")).toBe(true);
    expect(paperHasGlobalConfig("1.21.4")).toBe(true);
    expect(paperHasGlobalConfig("26.3")).toBe(true);
    expect(paperHasGlobalConfig("1.18.2")).toBe(false);
  });
});

describe("Velocity plugins", () => {
  const root = path.join(os.tmpdir(), `cp-velocity-${process.pid}`);
  afterAll(() => fsp.rm(root, { recursive: true, force: true }));

  async function jar(file: string, meta: unknown) {
    const src = path.join(root, "src", file);
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, "velocity-plugin.json"), JSON.stringify(meta));
    await createZip({ sourceDir: src, destination: path.join(root, "plugins", file) });
  }

  it("reads velocity-plugin.json and resolves dependencies by plugin id", async () => {
    await jar("luckperms.jar", { id: "luckperms", name: "LuckPerms", version: "5.5.17", authors: ["Luck"], main: "me.lucko.luckperms.velocity.LPVelocityBootstrap" });
    await jar("tab.jar", { id: "tab", name: "TAB", version: "5.2.0", dependencies: [{ id: "luckperms", optional: true }, { id: "viaversion", optional: false }] });
    const list = await listPlugins(path.join(root, "plugins"), "plugins", "velocity");
    expect(list.map((p) => [p.name, p.version, p.missingDependencies])).toEqual([
      ["LuckPerms", "5.5.17", []],
      ["TAB", "5.2.0", ["viaversion"]],
    ]);
    expect(list[1].softDepend).toEqual(["luckperms"]);
  });
});
