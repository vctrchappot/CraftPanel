import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

/**
 * Where finished backup archives live. Only the local filesystem ships today;
 * an S3-compatible implementation can be added without touching callers.
 */
export interface BackupStorage {
  readonly id: string;
  /** Absolute local path where a new archive should be written before `commit`. */
  stagingPath(key: string): string;
  commit(key: string): Promise<void>;
  open(key: string): Promise<Readable>;
  localPath(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class LocalBackupStorage implements BackupStorage {
  readonly id = "local";
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) || key.includes("..")) throw new Error("Invalid backup key");
    return path.join(this.root, ...key.split("/"));
  }
  stagingPath(key: string): string {
    return this.pathFor(key);
  }
  async commit(_key: string): Promise<void> {}
  async open(key: string): Promise<Readable> {
    return fs.createReadStream(this.pathFor(key));
  }
  async localPath(key: string): Promise<string> {
    return this.pathFor(key);
  }
  async remove(key: string): Promise<void> {
    await fsp.rm(this.pathFor(key), { force: true });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
