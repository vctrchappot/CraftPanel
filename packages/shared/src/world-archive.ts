/**
 * Working out which world(s) a zip holds, from its entry names alone. The API uses it to import and the
 * dashboard to check an archive before uploading gigabytes, so both always agree.
 */

export type WorldDimension = "overworld" | "nether" | "the_end";

export interface WorldImportFolder {
  /** Folder inside the archive ("" when level.dat sits at the top). */
  source: string;
  /** Folder name relative to the imported world's name: "", "_nether" or "_the_end". */
  suffix: "" | "_nether" | "_the_end";
}

export interface WorldImportPlan {
  folders: WorldImportFolder[];
  /** Name of the world's folder in the archive, "" when it sits at the top. */
  sourceName: string;
  dimensions: WorldDimension[];
}

export type WorldImportResult = { ok: true; plan: WorldImportPlan } | { ok: false; message: string; hint?: string };

const DIMENSION_FOLDERS: [string, WorldDimension][] = [
  ["DIM-1", "nether"],
  ["DIM1", "the_end"],
  ["dimensions/minecraft/the_nether", "nether"],
  ["dimensions/minecraft/the_end", "the_end"],
];

const segments = (dir: string) => (dir ? dir.split("/").length : 0);
const baseName = (dir: string) => dir.slice(dir.lastIndexOf("/") + 1);
const parentOf = (dir: string) => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");

/**
 * Accepts a world at the top, in one or two wrapper folders (a singleplayer `saves` folder, a whole server
 * folder), and Paper's layout of `world`, `world_nether` and `world_the_end` side by side.
 */
export function planWorldImport(entryNames: string[]): WorldImportResult {
  const names = entryNames.map((n) => n.replace(/\\/g, "/")).filter((n) => !n.startsWith("__MACOSX/"));
  const found = new Set<string>();
  for (const n of names) {
    if (!/(^|\/)level\.dat$/.test(n)) continue;
    const dir = n.slice(0, -"level.dat".length).replace(/\/$/, "");
    if (segments(dir) <= 2) found.add(dir);
  }
  // A level.dat inside another world's folder (a nested backup, say) is not a world of its own.
  const dirs = [...found].filter((d) => ![...found].some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))));
  if (!dirs.length) {
    return { ok: false, message: "This archive does not contain a Minecraft world (no level.dat found)", hint: "Zip the world folder itself, the one that holds level.dat and the region folder." };
  }

  let main = dirs[0];
  const folders: WorldImportFolder[] = [];
  if (dirs.length > 1) {
    const parents = new Set(dirs.map(parentOf));
    const candidate = parents.size === 1 ? dirs.find((d) => dirs.every((o) => o === d || o === `${d}_nether` || o === `${d}_the_end`)) : undefined;
    if (!candidate) {
      const list = dirs.slice(0, 4).map((d) => `"${d || "(top level)"}"`).join(", ");
      return { ok: false, message: `This archive contains several worlds (${list}${dirs.length > 4 ? ", …" : ""})`, hint: "Import one world at a time: zip just the folder of the world you want." };
    }
    main = candidate;
  }
  folders.push({ source: main, suffix: "" });
  for (const suffix of ["_nether", "_the_end"] as const) {
    if (dirs.includes(`${main}${suffix}`)) folders.push({ source: `${main}${suffix}`, suffix });
  }

  const dimensions = new Set<WorldDimension>(["overworld"]);
  for (const f of folders) if (f.suffix) dimensions.add(f.suffix === "_nether" ? "nether" : "the_end");
  const prefix = main ? `${main}/` : "";
  for (const [dir, label] of DIMENSION_FOLDERS) if (names.some((n) => n.startsWith(`${prefix}${dir}/`))) dimensions.add(label);
  return { ok: true, plan: { folders, sourceName: baseName(main), dimensions: [...dimensions] } };
}

/** A name that is not taken yet: "World", "World 2", "World 3" … */
export function uniqueWorldName(wanted: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = wanted.trim() || "World";
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The world name a file or folder name suggests, limited to what `levelNameSchema` accepts. */
export function suggestWorldName(fileOrFolder: string): string {
  return fileOrFolder.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/^\.+/, "").slice(0, 64).trim() || "World";
}

/** What `File` and `Blob` offer; lets the same reader serve the browser and tests. */
export interface ByteSource {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;

/**
 * The entry names of a zip, read from its central directory (the last few bytes plus the directory itself),
 * without reading the archive. Returns null when it cannot be read; the server decides then.
 */
export async function readZipEntryNames(source: ByteSource, maxEntries = 500_000): Promise<string[] | null> {
  try {
    const tailSize = Math.min(source.size, 65_557);
    const tail = new DataView(await source.slice(source.size - tailSize, source.size).arrayBuffer());
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    let count = tail.getUint16(eocd + 10, true);
    let size = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      if (eocd < 20 || tail.getUint32(eocd - 20, true) !== EOCD64_LOCATOR) return null;
      const at = Number(tail.getBigUint64(eocd - 20 + 8, true));
      const z64 = new DataView(await source.slice(at, at + 56).arrayBuffer());
      count = Number(z64.getBigUint64(32, true));
      size = Number(z64.getBigUint64(40, true));
      offset = Number(z64.getBigUint64(48, true));
    }
    if (count > maxEntries || offset + size > source.size) return null;
    const dir = new DataView(await source.slice(offset, offset + size).arrayBuffer());
    const bytes = new Uint8Array(dir.buffer);
    const names: string[] = [];
    let pos = 0;
    while (pos + 46 <= dir.byteLength && dir.getUint32(pos, true) === CENTRAL) {
      const nameLength = dir.getUint16(pos + 28, true);
      const skip = nameLength + dir.getUint16(pos + 30, true) + dir.getUint16(pos + 32, true);
      const raw = bytes.subarray(pos + 46, pos + 46 + nameLength);
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        name = new TextDecoder("latin1").decode(raw);
      }
      names.push(name);
      pos += 46 + skip;
    }
    return names.length ? names : null;
  } catch {
    return null;
  }
}
