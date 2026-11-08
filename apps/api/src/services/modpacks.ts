import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { badRequest, notFound } from "@craftpanel/shared";
import { downloadModpack, readModpack, type ModpackInfo } from "@craftpanel/minecraft-providers";

/** A pack waiting to become a server: checked once when it arrives, used by the create request. */
export interface PreparedModpack {
  id: string;
  info: ModpackInfo;
  /** Modrinth project/version when it came from the catalogue. */
  source: { projectId: string | null; versionId: string } | null;
}

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** File CraftPanel keeps in a new server's directory until the pack's files are installed (retries reuse it). */
export const PENDING_MODPACK = ".craftpanel-modpack.mrpack";
/** What the server was created from; read for the overview. */
export const MODPACK_RECORD = ".craftpanel-modpack.json";

/** Staging area for .mrpack files between "inspect" and "create server". */
export class ModpackStaging {
  constructor(private tmp: string) {}

  private file(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw badRequest("Invalid modpack id");
    return path.join(this.tmp, `modpack-${id}.mrpack`);
  }

  /** Download a Modrinth modpack version and check it. */
  async fromModrinth(versionId: string): Promise<PreparedModpack> {
    await this.prune();
    const id = crypto.randomUUID();
    const file = this.file(id);
    try {
      const v = await downloadModpack(versionId, file);
      return await this.inspect(id, file, { projectId: v.projectId, versionId: v.id });
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw badRequest((err as Error).message);
    }
  }

  /** Adopt an uploaded .mrpack (moved, not copied). */
  async fromUpload(upload: string): Promise<PreparedModpack> {
    await this.prune();
    const id = crypto.randomUUID();
    const file = this.file(id);
    await fsp.rename(upload, file);
    try {
      return await this.inspect(id, file, null);
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw badRequest((err as Error).message);
    }
  }

  private async inspect(id: string, file: string, source: PreparedModpack["source"]): Promise<PreparedModpack> {
    const { info } = await readModpack(file);
    const prepared = { id, info, source };
    await fsp.writeFile(`${file}.json`, JSON.stringify(prepared));
    return prepared;
  }

  /** The staged pack, or 404 once it expired. */
  async get(id: string): Promise<PreparedModpack & { file: string }> {
    const file = this.file(id);
    try {
      const prepared = JSON.parse(await fsp.readFile(`${file}.json`, "utf8")) as PreparedModpack;
      await fsp.access(file);
      return { ...prepared, file };
    } catch {
      throw notFound("The modpack is no longer available. Choose it again.");
    }
  }

  /** Move the staged pack into a new server directory. */
  async claim(id: string, directory: string): Promise<void> {
    const { file, ...prepared } = await this.get(id);
    const target = path.join(directory, PENDING_MODPACK);
    try {
      await fsp.rename(file, target);
    } catch {
      // Different file system (custom storage location).
      await fsp.copyFile(file, target);
      await fsp.rm(file, { force: true });
    }
    await fsp.writeFile(path.join(directory, MODPACK_RECORD), JSON.stringify({ ...prepared.info, source: prepared.source, installedAt: null }, null, 2));
    await fsp.rm(`${file}.json`, { force: true });
  }

  /** Remove packs nobody created a server from. */
  async prune() {
    await fsp.mkdir(this.tmp, { recursive: true });
    for (const name of await fsp.readdir(this.tmp)) {
      if (!name.startsWith("modpack-")) continue;
      const p = path.join(this.tmp, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > MAX_AGE_MS) await fsp.rm(p, { force: true });
    }
  }
}
