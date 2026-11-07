import { fetchJson, TtlCache } from "./download";

const META = "https://meta.fabricmc.net/v2";

export interface FabricComponent {
  version: string;
  stable: boolean;
}

const gameCache = new TtlCache<FabricComponent[]>(10 * 60 * 1000);
const loaderCache = new TtlCache<FabricComponent[]>(10 * 60 * 1000);
const installerCache = new TtlCache<FabricComponent[]>(60 * 60 * 1000);

/** Minecraft versions Fabric supports (stable = final releases), newest first. */
export function listFabricGameVersions(): Promise<FabricComponent[]> {
  return gameCache.get("game", () => fetchJson<FabricComponent[]>(`${META}/versions/game`));
}

/** Fabric Loader versions, newest first. Loader versions are independent of the game version. */
export function listFabricLoaders(): Promise<FabricComponent[]> {
  return loaderCache.get("loader", async () => (await fetchJson<FabricComponent[]>(`${META}/versions/loader`)).map(({ version, stable }) => ({ version, stable })));
}

export function listFabricInstallers(): Promise<FabricComponent[]> {
  return installerCache.get("installer", async () => (await fetchJson<FabricComponent[]>(`${META}/versions/installer`)).map(({ version, stable }) => ({ version, stable })));
}

const SAFE = /^[A-Za-z0-9._+-]{1,64}$/;

/** The requested loader (or the newest stable one) and the newest stable installer. */
export async function resolveFabricLaunch(loader?: string | null): Promise<{ loader: string; installer: string }> {
  const [loaders, installers] = await Promise.all([listFabricLoaders(), listFabricInstallers()]);
  const chosen = loader ? loaders.find((l) => l.version === loader) : (loaders.find((l) => l.stable) ?? loaders[0]);
  if (!chosen) throw new Error(loader ? `Fabric Loader ${loader} not found` : "Fabric publishes no loader versions");
  const installer = installers.find((i) => i.stable) ?? installers[0];
  if (!installer) throw new Error("Fabric publishes no installer versions");
  return { loader: chosen.version, installer: installer.version };
}

/**
 * The Fabric server launcher: a small jar that, on first start, fetches Fabric
 * Loader and its libraries and then starts the vanilla server.jar next to it.
 */
export function fabricLauncherUrl(game: string, loader: string, installer: string): string {
  for (const part of [game, loader, installer]) if (!SAFE.test(part)) throw new Error("Invalid Fabric version");
  return `${META}/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
}
