import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerSandbox } from "../src/sandbox";

let root: string;
let outside: string;
let sb: ServerSandbox;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-sandbox-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "cp-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fs.mkdir(path.join(root, "world"));
  await fs.writeFile(path.join(root, "server.properties"), "motd=hi\n");
  // Junctions work on Windows without admin rights; symlinks elsewhere.
  await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  sb = new ServerSandbox(root);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("ServerSandbox", () => {
  it("reads and writes files inside the root", async () => {
    await sb.writeText("world/notes.txt", "hello");
    expect(await sb.readText("world/notes.txt")).toBe("hello");
  });

  it.each(["../secret.txt", "..\\..\\secret.txt", "world/../../x", "C:\\Windows\\win.ini", "\\\\server\\share\\x", "a\0b"])("rejects traversal: %s", async (p) => {
    await expect(sb.resolve(p)).rejects.toThrow();
  });

  it("refuses to follow symlinks/junctions out of the root", async () => {
    await expect(sb.readText("escape/secret.txt")).rejects.toThrow(/Symbolic links|escapes/);
    await expect(sb.writeText("escape/new.txt", "x")).rejects.toThrow();
    const listing = await sb.list("");
    expect(listing.map((e) => e.name)).not.toContain("escape");
  });

  it("refuses to delete the root", async () => {
    await expect(sb.remove("")).rejects.toThrow(/root/);
    await expect(sb.remove(".")).rejects.toThrow(/root/);
  });

  it("detects binary files", async () => {
    await fs.writeFile(path.join(root, "level.dat"), Buffer.from([0x1f, 0x8b, 0, 0, 1, 2]));
    await expect(sb.readText("level.dat")).rejects.toThrow(/binary/);
  });
});

describe("leading slashes", () => {
  it("are interpreted relative to the server root, never the host root", async () => {
    const p = await sb.resolve("/etc/passwd");
    expect(p.startsWith(await fs.realpath(root))).toBe(true);
  });
});

describe("directorySize", () => {
  it("sums every file, including many concurrent ones", async () => {
    const { directorySize } = await import("../src/sandbox");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-size-"));
    await fs.mkdir(path.join(dir, "region"));
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(dir, "region", `r.${i}.mca`), Buffer.alloc(1000));
    await fs.writeFile(path.join(dir, "level.dat"), Buffer.alloc(500));
    expect(await directorySize(dir)).toBe(50_500);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
