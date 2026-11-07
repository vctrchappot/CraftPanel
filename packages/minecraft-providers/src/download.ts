import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const USER_AGENT = "CraftPanel/0.1 (+https://github.com/craftpanel/craftpanel)";

export interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface DownloadOptions {
  url: string;
  destination: string;
  checksum?: { algorithm: "sha1" | "sha256" | "sha512"; value: string };
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  maxBytes?: number;
}

const TRUSTED_HOSTS = [
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launchermeta.mojang.com",
  "launcher.mojang.com",
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.papermc.io",
  "api.adoptium.net",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.modrinth.com",
  "cdn.modrinth.com",
];

/** Only official/vetted hosts are allowed as download sources. */
export function assertTrustedUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`Refusing non-HTTPS download: ${url}`);
  if (!TRUSTED_HOSTS.includes(u.hostname)) throw new Error(`Refusing download from untrusted host: ${u.hostname}`);
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  assertTrustedUrl(url);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Request to ${new URL(url).hostname} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Download to a temp file, verify the checksum, then atomically move into
 * place. Redirects are followed by fetch but the final host is re-checked.
 */
export async function download(opts: DownloadOptions): Promise<void> {
  assertTrustedUrl(opts.url);
  const res = await fetch(opts.url, { headers: { "User-Agent": USER_AGENT }, signal: opts.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${new URL(opts.url).hostname}`);
  assertTrustedUrl(res.url || opts.url);
  const total = Number(res.headers.get("content-length")) || null;
  if (opts.maxBytes && total && total > opts.maxBytes) throw new Error("Download is larger than allowed");

  await fsp.mkdir(path.dirname(opts.destination), { recursive: true });
  const tmp = `${opts.destination}.download`;
  const hash = opts.checksum ? crypto.createHash(opts.checksum.algorithm) : null;
  let received = 0;
  let lastEmit = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _e, done) {
      received += chunk.length;
      if (opts.maxBytes && received > opts.maxBytes) return done(new Error("Download is larger than allowed"));
      hash?.update(chunk);
      const now = Date.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        opts.onProgress?.({ received, total });
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(tmp), { signal: opts.signal });
    if (hash && opts.checksum) {
      const actual = hash.digest("hex");
      if (actual.toLowerCase() !== opts.checksum.value.toLowerCase())
        throw new Error(`Checksum verification failed (${opts.checksum.algorithm}). The download may be corrupted or tampered with.`);
    }
    await fsp.rename(tmp, opts.destination);
    opts.onProgress?.({ received, total: total ?? received });
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export async function hashFile(file: string, algorithm: "sha1" | "sha256" | "sha512"): Promise<string> {
  const h = crypto.createHash(algorithm);
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

/** Tiny TTL cache for metadata requests. */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private ttlMs: number) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.store.set(key, { at: Date.now(), value });
    value.catch(() => this.store.delete(key));
    return value;
  }
}
