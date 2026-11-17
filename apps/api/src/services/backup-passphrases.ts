import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

/** Host-local schedule secrets. Deliberately outside the database and application archives. */
export class BackupPassphrases {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private get file() { return path.join(this.root, "application-backup-passphrases.json"); }
  private async read(): Promise<Record<string, string>> {
    const text = await fsp.readFile(this.file, "utf8").catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return "{}"; throw err; });
    return z.record(z.string().uuid(), z.string().min(10).max(1024)).parse(JSON.parse(text));
  }
  async get(id: string) { await this.pending.catch(() => undefined); return (await this.read())[id]; }
  async set(id: string, passphrase: string | null) {
    z.string().uuid().parse(id);
    if (passphrase !== null) z.string().min(10).max(1024).parse(passphrase);
    const operation = this.pending.catch(() => undefined).then(async () => {
      const secrets = await this.read();
      if (passphrase === null && !Object.hasOwn(secrets, id)) return;
      if (passphrase === null) delete secrets[id]; else secrets[id] = passphrase;
      const temporary = `${this.file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
        await fsp.rename(temporary, this.file);
        await fsp.chmod(this.file, 0o600);
      } finally { await fsp.rm(temporary, { force: true }); }
    });
    this.pending = operation;
    await operation;
  }
}
