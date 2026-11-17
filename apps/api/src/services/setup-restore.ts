import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AppError, conflict } from "@craftpanel/shared";
import { openDatabase, runMigrations } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import type { AppContext } from "../context";
import { safeEqual } from "../auth/sessions";
import { importApplicationBackup, type ImportResult } from "../app-restore";
import { rollbackRestore, writeRestoreJournal, type RestoreTransfer } from "../setup-restore-transaction";

export interface SetupRestoreProgress { running: boolean; message: string; error: string | null; result: ImportResult | null; recoveryRequired?: boolean }
const exists = (file: string) => fsp.access(file).then(() => true, () => false);

/** Exclusive first-run setup/restore. A restore stages and validates everything before replacing the empty database. */
export class SetupRestoreService {
  private busy = false;
  activating = false;
  private token = "";
  private issuedAt = 0;
  private preserve = new Set<string>();
  private state: SetupRestoreProgress = { running: false, message: "", error: null, result: null };
  constructor(private ctx: AppContext, private migrationsFolder?: string) {}

  reserve() {
    if (this.busy) throw conflict("First-run setup or restoration is already in progress");
    this.busy = true;
    return () => { this.busy = false; };
  }

  assertFresh(setupToken?: string) {
    const ctx = this.ctx;
    if (ctx.database.raw.prepare("SELECT 1 FROM users LIMIT 1").get()) throw conflict("CraftPanel is already set up");
    if (ctx.setupToken && !safeEqual(setupToken ?? "", ctx.setupToken)) throw new AppError(403, "setup_token_invalid", "Invalid setup token");
    if (ctx.database.raw.prepare("SELECT 1 FROM servers LIMIT 1").get() || !ctx.agent.connected || ctx.agent.serverIds().length)
      throw conflict("Browser restoration requires a fresh installation with no game servers. Use offline import for an existing installation.");
  }

  status(token?: string) {
    if (!token || !this.token || !safeEqual(token, this.token) || Date.now() - this.issuedAt > 3600_000) throw new AppError(404, "not_found", "Restore session not found");
    return { ...this.state };
  }

  start(file: string, work: string, passphrase: string | undefined, release: () => void) {
    this.token = crypto.randomBytes(24).toString("hex");
    this.issuedAt = Date.now();
    this.state = { running: true, message: "Checking the backup", error: null, result: null };
    void (async () => {
      let completed: SetupRestoreProgress;
      try { completed = { running: false, message: "Restoration complete", error: null, result: await this.restore(file, work, passphrase) }; }
      catch (err) { completed = { running: false, message: "Restoration failed", error: (err as Error).message, result: null, recoveryRequired: this.preserve.has(work) }; }
      finally {
        if (!this.preserve.has(work)) await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
        release();
      }
      this.state = completed;
    })();
    return { token: this.token };
  }

  private async restore(file: string, work: string, passphrase?: string): Promise<ImportResult> {
    const ctx = this.ctx;
    const target = ctx.config.layout;
    const stage = dataLayout(path.join(work, "staged"));
    const result = await importApplicationBackup(stage, file, { passphrase, targetLayout: target, log: (message) => { this.state.message = message; } });
    const hostSettings = await ctx.settings.get();
    const candidate = openDatabase(stage.database);
    try {
      await runMigrations(candidate, this.migrationsFolder);
      if (!candidate.raw.prepare("SELECT 1 FROM users WHERE role = 'owner' AND disabled = 0 LIMIT 1").get()) throw new Error("The backup has no active owner account");
      // Keep the new host reachable; the archive's allowlist may describe a different network.
      for (const [key, value] of Object.entries({ dashboardAccess: hostSettings.dashboardAccess, allowedNetworks: hostSettings.allowedNetworks }))
        candidate.raw.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
    } finally { candidate.close(); }

    this.assertFresh(ctx.setupToken ?? undefined);
    const transfers: RestoreTransfer[] = [];
    for (const id of await fsp.readdir(stage.servers)) transfers.push({ from: path.join(stage.servers, id), to: path.join(target.servers, id) });
    for (const id of await fsp.readdir(stage.backups).catch(() => [] as string[])) transfers.push({ from: path.join(stage.backups, id), to: path.join(target.backups, id) });
    transfers.push({ from: path.join(stage.root, "import"), to: path.join(target.root, "import"), replace: true });
    transfers.push({ from: stage.database, to: target.database, replace: true });
    for (const transfer of transfers) if (!transfer.replace && await exists(transfer.to)) throw new Error("The new installation already contains files for an imported server");

    let closed = false;
    this.activating = true;
    this.state.message = "Activating the restored installation";
    try {
      ctx.schedules.stop();
      ctx.notifications.stop();
      ctx.maps.stop();
      await ctx.rules.stop();
      // No other setup request can run while this reservation is held.
      if (ctx.database.raw.prepare("SELECT 1 FROM users LIMIT 1").get()) throw conflict("CraftPanel is already set up");
      ctx.database.close();
      closed = true;
      for (const suffix of ["-wal", "-shm"]) await fsp.rm(target.database + suffix, { force: true });
      await fsp.mkdir(path.join(work, "previous"));
      await writeRestoreJournal(work, transfers, "activating");
      for (const [index, transfer] of transfers.entries()) {
        await fsp.mkdir(path.dirname(transfer.to), { recursive: true });
        if (transfer.replace && await exists(transfer.to)) {
          const saved = path.join(work, "previous", String(index));
          await fsp.rename(transfer.to, saved);
        }
        await fsp.rename(transfer.from, transfer.to);
      }
      ctx.database.reopen();
      closed = false;
      ctx.settings.invalidate();
      await writeRestoreJournal(work, transfers, "committed");
    } catch (error) {
      try {
        if (!closed) { ctx.database.close(); closed = true; }
        await rollbackRestore(work, transfers, target.database);
        ctx.database.reopen();
        closed = false;
        ctx.settings.invalidate();
      }
      catch (rollbackError) { this.preserve.add(work); throw rollbackError; }
      throw error;
    } finally {
      if (!this.preserve.has(work)) {
        if (closed) ctx.database.reopen();
        this.activating = false;
        ctx.notifications.start();
        ctx.maps.start();
        await ctx.rules.start().catch((error) => result.notes.push(`Automation could not start: ${error.message}`));
      }
    }
    ctx.setupToken = null;
    await fsp.rm(path.join(target.root, "setup-token.txt"), { force: true }).catch(() => undefined);
    result.importDir = path.join(target.root, "import");
    result.notes = result.notes.map((note) => note.replaceAll(stage.root, target.root));
    await ctx.activity.event(null, "app-backup.restored", "Application backup restored during first-run setup").catch((error) => result.notes.push(`The restore event could not be recorded: ${error.message}`));
    await ctx.schedules.boot().catch((error) => result.notes.push(`Schedules could not start: ${error.message}`));
    await ctx.servers.recover().catch((error) => result.notes.push(`Servers could not be prepared: ${error.message}`));
    return result;
  }
}
