import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asGameAccount, detectIsolation, prepareServerDirectory, protectDataDirectory, shareJavaRuntime } from "../src/isolation";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
const mode = async (p: string) => (await fs.lstat(p)).mode & 0o7777;

async function layout() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "cp-iso-"));
  roots.push(data);
  const server = path.join(data, "servers", "alpha");
  await fs.mkdir(path.join(server, "world", "region"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(server, ".craftpanel"), "", { mode: 0o600 });
  await fs.writeFile(path.join(server, "server.properties"), "motd=x", { mode: 0o644 });
  await fs.writeFile(path.join(server, "start.sh"), "", { mode: 0o744 });
  await fs.writeFile(path.join(server, ".craftpanel-map.json"), "{}", { mode: 0o600 });
  await fs.writeFile(path.join(server, "world", "region", "r.0.0.mca"), "", { mode: 0o600 });
  return { data, server };
}

describe.skipIf(process.platform === "win32")("per-server isolation", () => {
  const slot = () => ({ index: 0, name: "craftpanel-game-00", uid: process.getuid!(), gid: process.getgid!() });

  it("opens a server directory to its group only and keeps private files private", async () => {
    const { data, server } = await layout();
    const outside = path.join(data, "secret.db");
    await fs.writeFile(outside, "x", { mode: 0o600 });
    await fs.symlink(outside, path.join(server, "link.db"));
    await prepareServerDirectory(server, slot(), data);
    expect(await mode(server)).toBe(0o2770);
    expect(await mode(path.join(server, "world", "region"))).toBe(0o2770);
    expect(await mode(path.join(server, "server.properties"))).toBe(0o660);
    expect(await mode(path.join(server, "start.sh"))).toBe(0o770);
    expect(await mode(path.join(server, "world", "region", "r.0.0.mca"))).toBe(0o660);
    expect(await mode(path.join(server, ".craftpanel-map.json"))).toBe(0o600);
    // Links are never followed.
    expect(await mode(outside)).toBe(0o600);
  });

  it("refuses directories without a marker, the data directory and runtime state", async () => {
    const { data, server } = await layout();
    await fs.rm(path.join(server, ".craftpanel"));
    await expect(prepareServerDirectory(server, slot(), data)).rejects.toThrow(/marker/);
    await expect(prepareServerDirectory(data, slot(), data)).rejects.toThrow(/Refusing/);
    await expect(prepareServerDirectory(path.dirname(data), slot(), data)).rejects.toThrow(/Refusing/);
    await expect(prepareServerDirectory(path.join(data, "runtime", "x"), slot(), data)).rejects.toThrow(/Refusing/);
  });

  it("lets others traverse only to servers and Java, and shares downloaded Java", async () => {
    const { data, server } = await layout();
    await fs.chmod(data, 0o755);
    await fs.writeFile(path.join(data, "craftpanel.db"), "x", { mode: 0o644 });
    await fs.mkdir(path.join(data, "backups"), { mode: 0o755 });
    await fs.chmod(server, 0o755);
    const bin = path.join(data, "runtimes", "java", "temurin-21", "bin");
    await fs.mkdir(bin, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(bin, "java"), "", { mode: 0o700 });
    await protectDataDirectory(data);
    expect(await mode(data)).toBe(0o751);
    expect(await mode(path.join(data, "craftpanel.db"))).toBe(0o640);
    expect(await mode(path.join(data, "backups"))).toBe(0o750);
    expect((await mode(path.join(data, "servers"))) & 0o007).toBe(0o001);
    expect(await mode(server)).toBe(0o750);
    await shareJavaRuntime(path.join(bin, "java"), data);
    expect(await mode(path.join(bin, "java"))).toBe(0o705);
    expect(await mode(bin)).toBe(0o705);
    // Java outside the data directory is left alone.
    await shareJavaRuntime("/usr/bin/java", data);
  });

  it("drops groups and capabilities before running the game", () => {
    const { file, args } = asGameAccount("/usr/bin/setpriv", { index: 3, name: "craftpanel-game-03", uid: 1203, gid: 1203 }, "/opt/java", ["-jar", "server.jar"]);
    expect(file).toBe("/usr/bin/setpriv");
    expect(args).toEqual(["--reuid=1203", "--regid=1203", "--clear-groups", "--inh-caps=-all", "--", "/opt/java", "-jar", "server.jar"]);
  });

  it("stays shared without game accounts or when disabled", async () => {
    expect((await detectIsolation({ CRAFTPANEL_ISOLATION: "off" })).mode).toBe("shared");
    // CI runners have no craftpanel-game accounts and no capabilities.
    expect((await detectIsolation({})).mode).toBe("shared");
  });
});
