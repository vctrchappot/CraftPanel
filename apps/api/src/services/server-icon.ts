import zlib from "node:zlib";
import { badRequest } from "@craftpanel/shared";

/** Minecraft shows `server-icon.png` from the server folder in the multiplayer list; it has to be exactly 64×64. */
export const ICON_FILE = "server-icon.png";
export const ICON_SIZE = 64;
export const MAX_ICON_BYTES = 128 * 1024;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per colour type: greyscale, RGB, palette, greyscale + alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Check that a file is a well-formed 64×64 PNG before it goes into a server folder: chunk lengths and checksums,
 * header, one stream of image data that inflates to the size the header promises, and a closing chunk. The browser
 * draws the picture, so this is not an image decoder; it keeps a broken file from ending up as a server icon, where
 * the game would only log "couldn't load".
 */
export function checkIcon(png: Buffer): void {
  if (png.length > MAX_ICON_BYTES) throw badRequest("The icon is too large", `A 64×64 PNG is a few kilobytes; this one is ${Math.round(png.length / 1024)} KB.`);
  if (png.length < SIGNATURE.length + 25 || !png.subarray(0, 8).equals(SIGNATURE)) throw badRequest("This is not a PNG image");
  let pos = 8;
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
  const data: Buffer[] = [];
  let ended = false;
  while (pos + 12 <= png.length && !ended) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > png.length) throw badRequest("The PNG is cut off");
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (zlib.crc32(png.subarray(pos + 4, pos + 8 + length)) !== png.readUInt32BE(pos + 8 + length)) throw badRequest("The PNG is damaged");
    if (!header) {
      if (type !== "IHDR" || length !== 13) throw badRequest("This is not a PNG image");
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") ended = true;
    pos = end;
  }
  if (!header || !ended || !data.length) throw badRequest("The PNG is incomplete");
  if (header.width !== ICON_SIZE || header.height !== ICON_SIZE) throw badRequest("The icon has to be 64×64 pixels", `This image is ${header.width}×${header.height}.`);
  if (!DEPTHS[header.color]?.includes(header.depth) || header.interlace > 1) throw badRequest("This PNG uses an unsupported format");
  // A 64×64 image inflates to a few tens of kilobytes at most; cap it so a crafted stream can't balloon.
  const bytesPerRow = Math.ceil((ICON_SIZE * CHANNELS[header.color] * header.depth) / 8);
  const expected = ICON_SIZE * (1 + bytesPerRow);
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: 4 * ICON_SIZE * ICON_SIZE * 8 + 4096 });
  } catch {
    throw badRequest("The PNG's image data is damaged");
  }
  if (header.interlace === 0 && raw.length !== expected) throw badRequest("The PNG's image data does not match its size");
}
