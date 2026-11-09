import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import yauzl from "yauzl";
import { resolveInside, PathError } from "./safe-path";

export interface ZipProgress {
  bytesProcessed: number;
  totalBytes: number;
  currentFile?: string;
}

export interface CreateZipOptions {
  /** Directory whose contents are archived. */
  sourceDir: string;
  /** Destination .zip file (written to a temporary file first, then renamed). */
  destination: string;
  /** Return true to skip a relative path (POSIX separators). */
  exclude?: (relPath: string, isDirectory: boolean) => boolean;
  /** Prefix inside the archive. */
  prefix?: string;
  onProgress?: (p: ZipProgress) => void;
  signal?: AbortSignal;
}

interface WalkEntry {
  abs: string;
  rel: string;
  size: number;
  mtime: Date;
  dir: boolean;
}

async function walk(root: string, exclude: CreateZipOptions["exclude"]): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function rec(dir: string, rel: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      // Symlinks are never followed so archives cannot capture files outside the server.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (exclude?.(r, true)) continue;
        const st = await fsp.stat(abs);
        out.push({ abs, rel: r, size: 0, mtime: st.mtime, dir: true });
        await rec(abs, r);
      } else if (e.isFile()) {
        if (exclude?.(r, false)) continue;
        const st = await fsp.stat(abs);
        out.push({ abs, rel: r, size: st.size, mtime: st.mtime, dir: false });
      }
    }
  }
  await rec(root, "");
  return out;
}

/** Create a zip archive and return its SHA-256 and size. */
export async function createZip(opts: CreateZipOptions): Promise<{ sha256: string; size: number; files: number }> {
  const entries = await walk(opts.sourceDir, opts.exclude);
  const totalBytes = entries.reduce((n, e) => n + e.size, 0);
  const prefix = opts.prefix ? opts.prefix.replace(/\/+$/, "") + "/" : "";
  const zip = new yazl.ZipFile();
  let processed = 0;
  let lastEmit = 0;
  const emit = (file?: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    opts.onProgress?.({ bytesProcessed: processed, totalBytes, currentFile: file });
  };

  for (const e of entries) {
    if (e.dir) {
      zip.addEmptyDirectory(prefix + e.rel, { mtime: e.mtime });
      continue;
    }
    // Region files are already compressed; storing them is much faster.
    const compress = !/\.(mca|mcc|zip|jar|png|gz|ogg)$/i.test(e.rel);
    zip.addReadStreamLazy(prefix + e.rel, { mtime: e.mtime, size: e.size, compress }, (cb) => {
      if (opts.signal?.aborted) return cb(new Error("Backup cancelled"), undefined as never);
      const rs = fs.createReadStream(e.abs);
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          processed += chunk.length;
          emit(e.rel);
          done(null, chunk);
        },
      });
      rs.on("error", (err) => counter.destroy(err));
      cb(null, rs.pipe(counter));
    });
  }
  zip.end();

  await fsp.mkdir(path.dirname(opts.destination), { recursive: true });
  const tmp = `${opts.destination}.partial`;
  const hash = crypto.createHash("sha256");
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(zip.outputStream as unknown as NodeJS.ReadableStream, hasher, fs.createWriteStream(tmp), { signal: opts.signal });
    await fsp.rename(tmp, opts.destination);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  emit(undefined, true);
  return { sha256: hash.digest("hex"), size, files: entries.filter((e) => !e.dir).length };
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  directory: boolean;
}

export interface ExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ExtractLimits = { maxEntries: 200_000, maxTotalBytes: 64 * 1024 ** 3 };

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function checkEntryName(name: string): void {
  const err = yauzl.validateFileName(name);
  if (err) throw new PathError(`Unsafe archive entry "${name}": ${err}`);
  if (name.split("/").some((seg) => seg === "..")) throw new PathError(`Unsafe archive entry "${name}"`);
}

async function forEachEntry(file: string, fn: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<void>): Promise<void> {
  const zip = await yauzl.openPromise(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false, decodeStrings: true } as yauzl.Options);
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        fn(entry, zip).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

/** Read a single (small) entry from an archive; returns null if absent. */
export async function readZipEntry(file: string, name: string, maxBytes = 1024 * 1024): Promise<Buffer | null> {
  let found: Buffer | null = null;
  await forEachEntry(file, async (entry, zip) => {
    if (found || entry.fileName !== name) return;
    if (entry.uncompressedSize > maxBytes) throw new Error(`${name} is too large`);
    const rs = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const c of rs) chunks.push(c as Buffer);
    found = Buffer.concat(chunks);
  });
  return found;
}

export async function listZip(file: string): Promise<ZipEntryInfo[]> {
  const out: ZipEntryInfo[] = [];
  await forEachEntry(file, async (e) => {
    out.push({ name: e.fileName, size: e.uncompressedSize, compressedSize: e.compressedSize, directory: e.fileName.endsWith("/") });
  });
  return out;
}

/**
 * Verify an archive: optional SHA-256 match plus decompression of every
 * entry with CRC-32 comparison.
 */
export async function verifyZip(file: string, expectedSha256?: string | null): Promise<{ ok: boolean; entries: number; error?: string }> {
  try {
    if (expectedSha256) {
      const actual = await sha256File(file);
      if (actual !== expectedSha256) return { ok: false, entries: 0, error: "Checksum mismatch: the backup file was modified or corrupted" };
    }
    let entries = 0;
    await forEachEntry(file, async (entry, zip) => {
      entries++;
      if (entry.fileName.endsWith("/")) return;
      const rs = await zip.openReadStreamPromise(entry);
      let crc = 0;
      for await (const chunk of rs) crc = zlib.crc32(chunk as Buffer, crc);
      if (crc >>> 0 !== entry.crc32 >>> 0) throw new Error(`CRC mismatch in ${entry.fileName}`);
    });
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, entries: 0, error: (err as Error).message };
  }
}

export interface ExtractOptions {
  file: string;
  destination: string;
  /** Only extract entries under this prefix (the prefix is stripped). */
  stripPrefix?: string;
  /** Only extract entries this accepts (given the full entry name); the size limits still count the whole archive. */
  filter?: (name: string) => boolean;
  limits?: Partial<ExtractLimits>;
  onProgress?: (p: ZipProgress) => void;
}

/**
 * Extract an archive safely: rejects absolute paths, `..` segments, symlink
 * entries, and enforces entry-count and total-size limits (zip bombs).
 */
export async function extractZip(opts: ExtractOptions): Promise<{ files: number; bytes: number }> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const entries = await listZip(opts.file);
  if (entries.length > limits.maxEntries) throw new Error(`Archive has too many entries (${entries.length})`);
  const totalBytes = entries.reduce((n, e) => n + e.size, 0);
  if (totalBytes > limits.maxTotalBytes) throw new Error("Archive is too large to extract");

  await fsp.mkdir(opts.destination, { recursive: true });
  const destRoot = await fsp.realpath(opts.destination);
  let files = 0;
  let bytes = 0;
  const prefix = opts.stripPrefix ? opts.stripPrefix.replace(/\/+$/, "") + "/" : "";

  await forEachEntry(opts.file, async (entry, zip) => {
    if (opts.filter && !opts.filter(entry.fileName)) return;
    checkEntryName(entry.fileName);
    if (isSymlinkEntry(entry)) throw new PathError(`Archive contains a symbolic link (${entry.fileName}); refusing to extract`);
    let name = entry.fileName;
    if (prefix) {
      if (!name.startsWith(prefix)) return;
      name = name.slice(prefix.length);
      if (!name) return;
    }
    const target = resolveInside(destRoot, name);
    if (name.endsWith("/")) {
      await fsp.mkdir(target, { recursive: true });
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Re-check the parent's real path in case an existing directory is a symlink.
    const parentReal = await fsp.realpath(path.dirname(target));
    resolveInside(destRoot, path.relative(destRoot, parentReal) || ".");
    const rs = await zip.openReadStreamPromise(entry);
    let written = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        bytes += chunk.length;
        if (written > entry.uncompressedSize || bytes > limits.maxTotalBytes) return done(new Error("Archive entry exceeds its declared size"));
        opts.onProgress?.({ bytesProcessed: bytes, totalBytes, currentFile: name });
        done(null, chunk);
      },
    });
    await pipeline(rs, guard, fs.createWriteStream(target, { flags: "w" }));
    try {
      const mtime = entry.getLastModDate();
      await fsp.utimes(target, mtime, mtime);
    } catch {
      /* ignore */
    }
    files++;
  });
  return { files, bytes };
}
