import { TtlCache } from "./download";

const cache = new TtlCache<{ id: string; name: string } | null>(60 * 60 * 1000);

function dashed(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Look up a Java Edition profile via Mojang's official API. */
export function lookupProfile(name: string): Promise<{ id: string; name: string } | null> {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return Promise.resolve(null);
  return cache.get(name.toLowerCase(), async () => {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${name}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Mojang profile lookup failed (HTTP ${res.status})`);
    const body = (await res.json()) as { id: string; name: string };
    return { id: dashed(body.id), name: body.name };
  });
}
