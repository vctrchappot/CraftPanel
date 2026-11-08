import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const USER_AGENT = "CraftPanel (+https://github.com/vctrchappot/CraftPanel)";

export interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface DownloadOptions {
  url: string;
  destination: string;
  checksum?: { algorithm: "md5" | "sha1" | "sha256" | "sha512"; value: string };
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
  "api.purpurmc.org",
  "meta.fabricmc.net",
  "maven.neoforged.net",
  "api.papermc.io",
  "api.adoptium.net",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.modrinth.com",
  "cdn.modrinth.com",
  "hangar.papermc.io",
  "hangarcdn.papermc.io",
  // Allowed by the .mrpack format for modpack files (always checked against a SHA-512).
  "raw.githubusercontent.com",
  "gitlab.com",
];

/** Only official/vetted hosts are allowed as download sources. */
export function assertTrustedUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`Refusing non-HTTPS download: ${url}`);
  if (!TRUSTED_HOSTS.includes(u.hostname)) throw new Error(`Refusing download from untrusted host: ${u.hostname}`);
}

/** Delays before the second and third attempt; exported so tests can shorten them. */
export const RETRY_DELAYS_MS = [1000, 4000];

/**
 * fetch with a few retries for transient failures (5xx, 429, connection errors): GitHub and
 * the Minecraft CDNs answer 502/504 now and then, and one hiccup shouldn't fail an installation.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRY_DELAYS_MS.length;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (last || init.signal?.aborted || (err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw err;
      await wait(RETRY_DELAYS_MS[attempt], init.signal);
      continue;
    }
    if (last || !(res.status >= 500 || res.status === 429)) return res;
    await res.body?.cancel().catch(() => {});
    await wait(RETRY_DELAYS_MS[attempt], init.signal);
  }
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  assertTrustedUrl(url);
  const res = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Request to ${new URL(url).hostname} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Download to a temp file, verify the checksum, then atomically move into
 * place. Redirects are followed by fetch but the final host is re-checked.
 */
export async function download(opts: DownloadOptions): Promise<void> {
  assertTrustedUrl(opts.url);
  const res = await fetchWithRetry(opts.url, { headers: { "User-Agent": USER_AGENT }, signal: opts.signal, redirect: "follow" });
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

export async function hashFile(file: string, algorithm: "md5" | "sha1" | "sha256" | "sha512"): Promise<string> {
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
