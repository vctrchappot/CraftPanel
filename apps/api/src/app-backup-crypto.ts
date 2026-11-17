import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

// Versioned envelope: magic + header length + authenticated JSON header + ciphertext + 16-byte GCM tag.
const MAGIC = Buffer.from("CPBKENC1");
const MAX_HEADER = 2048;
const TAG_BYTES = 16;
const headerSchema = z.object({
  algorithm: z.literal("aes-256-gcm"),
  kdf: z.literal("scrypt-32768-8-1"),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  scheduleId: z.string().uuid().nullable(),
  servers: z.object({ total: z.number().int().min(0).max(1000), withFiles: z.number().int().min(0).max(1000) }),
  history: z.number().int().min(0).max(10000),
}).strict();
export type EncryptedBackupMetadata = Pick<z.infer<typeof headerSchema>, "scheduleId" | "servers" | "history">;

const deriveKey = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  crypto.scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (err, key) => err ? reject(err) : resolve(key));
});

export async function encryptedBackupHeader(file: string) {
  const handle = await fsp.open(file, "r");
  try {
    const prefix = Buffer.alloc(12);
    const first = await handle.read(prefix, 0, prefix.length, 0);
    if (first.bytesRead < 8 || !prefix.subarray(0, 8).equals(MAGIC)) return null;
    const size = prefix.readUInt32BE(8);
    if (first.bytesRead !== 12 || size < 1 || size > MAX_HEADER) throw new Error("Invalid encrypted backup header");
    const json = Buffer.alloc(size);
    if ((await handle.read(json, 0, size, 12)).bytesRead !== size) throw new Error("Truncated encrypted backup");
    const header = headerSchema.parse(JSON.parse(json.toString("utf8")));
    const offset = 12 + size;
    const stat = await handle.stat();
    if (stat.size <= offset + TAG_BYTES) throw new Error("Truncated encrypted backup");
    return { header, offset, size: stat.size, aad: Buffer.concat([prefix, json]) };
  } finally { await handle.close(); }
}

/** Encrypt a private staging ZIP; the published destination never contains plaintext. */
export async function encryptApplicationBackup(source: string, destination: string, passphrase: string, metadata: EncryptedBackupMetadata) {
  const header = headerSchema.parse({ algorithm: "aes-256-gcm", kdf: "scrypt-32768-8-1", salt: crypto.randomBytes(16).toString("hex"), iv: crypto.randomBytes(12).toString("hex"), ...metadata });
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(json.length, 8);
  const aad = Buffer.concat([prefix, json]);
  const key = await deriveKey(passphrase, Buffer.from(header.salt, "hex"));
  const temporary = `${destination}.partial`;
  let created = false;
  try {
    await fsp.writeFile(temporary, aad, { flag: "wx", mode: 0o600 });
    created = true;
    const cipher = crypto.createCipheriv("aes-256-gcm", key, Buffer.from(header.iv, "hex"));
    cipher.setAAD(aad);
    await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(temporary, { flags: "a" }));
    await fsp.appendFile(temporary, cipher.getAuthTag());
    await fsp.rename(temporary, destination);
  } finally {
    key.fill(0);
    if (created) await fsp.rm(temporary, { force: true });
  }
}

/** Authenticate all ciphertext before any ZIP parser or importer sees the decrypted file. */
export async function decryptApplicationBackup(source: string, destination: string, passphrase?: string): Promise<boolean> {
  const envelope = await encryptedBackupHeader(source);
  if (!envelope) return false;
  if (!passphrase) throw new Error("This backup is encrypted. Enter its passphrase.");
  const key = await deriveKey(passphrase, Buffer.from(envelope.header.salt, "hex"));
  let created = false;
  try {
    const handle = await fsp.open(source, "r");
    const tag = Buffer.alloc(TAG_BYTES);
    try {
      if ((await handle.read(tag, 0, tag.length, envelope.size - TAG_BYTES)).bytesRead !== TAG_BYTES) throw new Error("Truncated encrypted backup");
    } finally { await handle.close(); }
    const output = await fsp.open(destination, "wx", 0o600);
    created = true;
    await output.close();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.header.iv, "hex"));
    decipher.setAAD(envelope.aad);
    decipher.setAuthTag(tag);
    await pipeline(fs.createReadStream(source, { start: envelope.offset, end: envelope.size - TAG_BYTES - 1 }), decipher, fs.createWriteStream(destination, { flags: "w", mode: 0o600 }));
    return true;
  } catch {
    if (created) await fsp.rm(destination, { force: true });
    throw new Error("Incorrect passphrase or damaged encrypted backup");
  } finally { key.fill(0); }
}
