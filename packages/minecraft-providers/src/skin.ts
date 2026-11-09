import { TtlCache } from "./download";

/**
 * A player's skin from Mojang. Only accounts with a Mojang-issued (version 4) UUID have one; offline-mode servers
 * use name-based version 3 UUIDs, which no skin belongs to, so nothing is asked about those.
 */
export const isMojangUuid = (uuid: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SKIN_BYTES = 64 * 1024;
// Mojang writes these as http:// (the host serves https too); they are always fetched over https.
const TEXTURE_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{16,128}$/;

/** The (https) skin URL inside a session-server profile's base64 `textures` property, or null. */
export function skinUrlFromProfile(profile: unknown): string | null {
  const props = (profile as { properties?: { name?: string; value?: string }[] } | null)?.properties;
  const value = props?.find((p) => p.name === "textures")?.value;
  if (typeof value !== "string") return null;
  try {
    const url = (JSON.parse(Buffer.from(value, "base64").toString("utf8")) as { textures?: { SKIN?: { url?: string } } }).textures?.SKIN?.url;
    return typeof url === "string" && TEXTURE_URL.test(url) ? url.replace(/^http:/, "https:") : null;
  } catch {
    return null;
  }
}

/** A PNG of 64×64 or 64×32 pixels, the only sizes Minecraft skins have. */
export function isSkinPng(buf: Buffer): boolean {
  if (buf.length < 33 || buf.length > MAX_SKIN_BYTES || !buf.subarray(0, 8).equals(PNG) || buf.toString("ascii", 12, 16) !== "IHDR") return false;
  return buf.readUInt32BE(16) === 64 && (buf.readUInt32BE(20) === 64 || buf.readUInt32BE(20) === 32);
}

const urls = new TtlCache<string | null>(60 * 60 * 1000);

/** The skin PNG for a Mojang UUID; null when the account has none. Throws when Mojang can't be reached or says "later". */
export async function fetchSkin(uuid: string): Promise<Buffer | null> {
  if (!isMojangUuid(uuid)) return null;
  const url = await urls.get(uuid.toLowerCase(), async () => {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll("-", "")}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Mojang session server answered HTTP ${res.status}`);
    return skinUrlFromProfile(await res.json());
  });
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!res.ok) throw new Error(`Skin download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return isSkinPng(buf) ? buf : null;
}
