import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@craftpanel/shared";
import { isInside, PathError, resolveInside } from "@craftpanel/backup";

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/**
 * Filesystem access confined to one server directory. Every path is resolved
 * lexically, then the real path of the deepest existing ancestor is checked
 * so symlinks cannot be used to escape the root.
 */
export class ServerSandbox {
  private rootReal: string | null = null;

  constructor(public readonly root: string) {}

  private async realRoot(): Promise<string> {
    if (!this.rootReal) this.rootReal = await fsp.realpath(this.root);
    return this.rootReal;
  }

  /** Resolve an untrusted relative path to an absolute path inside the root. */
  async resolve(rel: string): Promise<string> {
    const root = await this.realRoot();
    const target = resolveInside(root, rel || ".");
    // Walk up to the deepest existing ancestor and confirm its real path.
    let probe = target;
    for (;;) {
      try {
        const st = await fsp.lstat(probe);
        if (st.isSymbolicLink()) throw new PathError("Symbolic links are not accessible through CraftPanel");
        const real = await fsp.realpath(probe);
        if (!isInside(root, real)) throw new PathError("Path escapes the server directory");
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return target;
  }

  toRelative(abs: string): string {
    return path.relative(this.rootReal ?? this.root, abs).split(path.sep).join("/");
  }

  async list(rel: string): Promise<FileEntry[]> {
    const dir = await this.resolve(rel);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      try {
        const st = await fsp.stat(abs);
        out.push({
          name: e.name,
          path: this.toRelative(abs),
          type: e.isDirectory() ? "directory" : "file",
          size: e.isDirectory() ? 0 : st.size,
          modifiedAt: st.mtimeMs,
        });
      } catch {
        /* vanished */
      }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  }

  async stat(rel: string) {
    return fsp.stat(await this.resolve(rel));
  }

  async readText(rel: string): Promise<string> {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new PathError("Not a file");
    if (st.size > MAX_TEXT_BYTES) throw new PathError("File is too large to edit in the browser (limit 5 MB). Download it instead.");
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new PathError("This looks like a binary file. Download it instead.");
    return buf.toString("utf8");
  }

  async readTextIfExists(rel: string): Promise<string | null> {
    try {
      return await this.readText(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Atomic write: temp file then rename. */
  async writeText(rel: string, content: string): Promise<void> {
    const abs = await this.resolve(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.craftpanel-${process.pid}.tmp`;
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, abs);
  }

  async openRead(rel: string): Promise<{ stream: fs.ReadStream; size: number; name: string }> {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new PathError("Not a file");
    return { stream: fs.createReadStream(abs), size: st.size, name: path.basename(abs) };
  }

  async writeStream(rel: string): Promise<{ stream: fs.WriteStream; finalize: () => Promise<void>; abort: () => Promise<void> }> {
    const abs = await this.resolve(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.craftpanel-upload.tmp`;
    const stream = fs.createWriteStream(tmp);
    return {
      stream,
      finalize: async () => {
        await fsp.rename(tmp, abs);
      },
      abort: async () => {
        await fsp.rm(tmp, { force: true });
      },
    };
  }

  async mkdir(rel: string): Promise<void> {
    await fsp.mkdir(await this.resolve(rel), { recursive: true });
  }

  async remove(rel: string): Promise<void> {
    const abs = await this.resolve(rel);
    if (abs === (await this.realRoot())) throw new PathError("Refusing to delete the server root");
    await fsp.rm(abs, { recursive: true, force: false });
  }

  async rename(from: string, to: string): Promise<void> {
    const a = await this.resolve(from);
    const b = await this.resolve(to);
    if (a === (await this.realRoot())) throw new PathError("Refusing to move the server root");
    try {
      await fsp.access(b);
      throw new PathError("A file with that name already exists");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fsp.access(await this.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }
}

/** Total size in bytes of a directory tree (symlinks not followed). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  async function rec(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) await rec(abs);
        else if (e.isFile()) {
          try {
            // Await first: `total += await x` would read `total` before awaiting and lose concurrent updates.
            const { size } = await fsp.stat(abs);
            total += size;
          } catch {
            /* ignore */
          }
        }
      }),
    );
  }
  await rec(dir);
  return total;
}

/** Free space on the volume containing `dir`, or null if unknown. */
export async function freeDiskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}
