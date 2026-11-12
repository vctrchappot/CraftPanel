import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createZip, extractZip, listZip, verifyZip } from "../src/archive";
import { resolveInside } from "../src/safe-path";

/** Build a stored (uncompressed) zip with arbitrary entry names, including malicious ones. */
function rawZip(entries: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode ? 0x0314 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-zip-"));
});
afterAll(async () => fs.rm(tmp, { recursive: true, force: true }));

describe("createZip / verifyZip / extractZip", () => {
  it("round-trips a directory, honours exclusions and verifies integrity", async () => {
    const src = path.join(tmp, "src");
    await fs.mkdir(path.join(src, "world/region"), { recursive: true });
    await fs.mkdir(path.join(src, "logs"));
    await fs.writeFile(path.join(src, "server.properties"), "motd=hi\n");
    await fs.writeFile(path.join(src, "world/region/r.0.0.mca"), Buffer.alloc(100_000, 7));
    await fs.writeFile(path.join(src, "world/session.lock"), "lock");
    await fs.writeFile(path.join(src, "logs/latest.log"), "log");
    const dest = path.join(tmp, "out.zip");
    const res = await createZip({ sourceDir: src, destination: dest, exclude: (rel) => rel.startsWith("logs") || rel.endsWith("session.lock") });
    expect(res.files).toBe(2);
    expect((await verifyZip(dest, res.sha256)).ok).toBe(true);
    const names = (await listZip(dest)).map((e) => e.name);
    expect(names).toContain("world/region/r.0.0.mca");
    expect(names.some((n) => n.startsWith("logs"))).toBe(false);

    const out = path.join(tmp, "extracted");
    await extractZip({ file: dest, destination: out });
    expect(await fs.readFile(path.join(out, "server.properties"), "utf8")).toBe("motd=hi\n");
    expect((await fs.stat(path.join(out, "world/region/r.0.0.mca"))).size).toBe(100_000);
  });

  // Isolated game accounts write some files as 0600; an unreadable file must fail the archive, not crash the process.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects instead of crashing on an unreadable file", async () => {
    const src = path.join(tmp, "private");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.txt"), "x".repeat(1000));
    await fs.writeFile(path.join(src, "level.dat"), "secret", { mode: 0o000 });
    const dest = path.join(tmp, "private.zip");
    await expect(createZip({ sourceDir: src, destination: dest })).rejects.toThrow(/EACCES/);
    await expect(fs.access(dest)).rejects.toThrow();
    await expect(fs.access(`${dest}.partial`)).rejects.toThrow();
  });

  it("detects tampering via checksum and CRC", async () => {
    const src = path.join(tmp, "src2");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.txt"), "x".repeat(1000));
    const dest = path.join(tmp, "t.zip");
    const { sha256 } = await createZip({ sourceDir: src, destination: dest });
    const buf = await fs.readFile(dest);
    buf[30 + "a.txt".length + 2] ^= 0xff; // inside the compressed data of the first entry
    await fs.writeFile(dest, buf);
    expect((await verifyZip(dest, sha256)).ok).toBe(false);
    expect((await verifyZip(dest, null)).ok).toBe(false);
  });

  it.each(["../evil.txt", "a/../../evil.txt", "/abs/evil.txt", "C:/evil.txt"])("rejects zip-slip entry %s", async (name) => {
    const file = path.join(tmp, `slip-${Math.random().toString(36).slice(2)}.zip`);
    await fs.writeFile(file, rawZip([{ name, data: Buffer.from("pwned") }]));
    await expect(extractZip({ file, destination: path.join(tmp, "slip-out") })).rejects.toThrow();
    await expect(fs.access(path.join(tmp, "evil.txt"))).rejects.toThrow();
  });

  it("rejects symlink entries", async () => {
    const file = path.join(tmp, "link.zip");
    await fs.writeFile(file, rawZip([{ name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }]));
    await expect(extractZip({ file, destination: path.join(tmp, "link-out") })).rejects.toThrow(/symbolic link/);
  });

  it("enforces size limits (zip bombs)", async () => {
    const file = path.join(tmp, "big.zip");
    await fs.writeFile(file, rawZip([{ name: "big.bin", data: Buffer.alloc(10_000) }]));
    await expect(extractZip({ file, destination: path.join(tmp, "big-out"), limits: { maxTotalBytes: 1000 } })).rejects.toThrow(/too large/);
  });
});

describe("resolveInside", () => {
  it("keeps paths inside the root", () => {
    const root = path.resolve("/srv/mc");
    expect(resolveInside(root, "world/level.dat")).toBe(path.join(root, "world", "level.dat"));
    expect(resolveInside(root, "/world")).toBe(path.join(root, "world"));
    expect(() => resolveInside(root, "../x")).toThrow();
  });
});
