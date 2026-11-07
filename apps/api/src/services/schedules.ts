import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { and, desc, eq, scheduleRuns, schedules, type Database } from "@craftpanel/database";
import { badRequest, notFound, scheduleSchema, type ScheduleInfo } from "@craftpanel/shared";
import { Scheduler, validateCron } from "@craftpanel/scheduler";
import { DDNS_PROVIDERS, fetchPublicIp } from "@craftpanel/network";
import type { z } from "zod";
import type { ActivityService, Actor } from "./activity";
import type { BackupService } from "./backups";
import type { ServerService } from "./servers";
import type { SettingsService } from "./settings";

type Row = typeof schedules.$inferSelect;
const SCHEDULER_ACTOR: Actor = { id: null, username: "scheduler" };
const DDNS_JOB = "__ddns__";

export class ScheduleService {
  private scheduler: Scheduler;

  constructor(
    private db: Database,
    private servers: ServerService,
    private backups: BackupService,
    private activity: ActivityService,
    private settings: SettingsService,
  ) {
    this.scheduler = new Scheduler(
      (id) => this.fire(id),
      (id, err) => void this.activity.event(null, "schedule.error", `Schedule ${id} failed: ${(err as Error).message}`, { level: "error" }),
    );
  }

  private toInfo(r: Row): ScheduleInfo {
    return {
      id: r.id,
      serverId: r.serverId,
      name: r.name,
      cron: r.cron,
      action: r.action as ScheduleInfo["action"],
      payload: JSON.parse(r.payload),
      enabled: r.enabled,
      lastRunAt: r.lastRunAt,
      lastStatus: r.lastStatus,
      nextRunAt: this.scheduler.nextRun(r.id)?.getTime() ?? null,
      createdAt: r.createdAt,
    };
  }

  async list(serverId?: string): Promise<ScheduleInfo[]> {
    const q = this.db.select().from(schedules);
    const rows = await (serverId ? q.where(eq(schedules.serverId, serverId)) : q).orderBy(schedules.createdAt);
    return rows.map((r) => this.toInfo(r));
  }

  async runs(scheduleId: string, limit = 50) {
    return this.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId)).orderBy(desc(scheduleRuns.startedAt)).limit(limit);
  }

  private validate(input: z.output<typeof scheduleSchema>) {
    const err = validateCron(input.cron);
    if (err) throw badRequest(`Invalid schedule: ${err}`);
    const serverActions = ["start", "restart", "stop", "backup", "announce", "command", "prune-backups", "cleanup-logs"];
    if (serverActions.includes(input.action) && !input.serverId) throw badRequest("This action needs a server");
    if (input.action === "announce" && !input.payload.message?.trim()) throw badRequest("Announcement text is required");
    if (input.action === "command" && !input.payload.command?.trim()) throw badRequest("Command is required");
    if (input.payload.command && /[\r\n]/.test(input.payload.command)) throw badRequest("Command must be a single line");
    if (input.payload.message && /[\r\n]/.test(input.payload.message)) throw badRequest("Message must be a single line");
  }

  async create(input: z.output<typeof scheduleSchema>, actor: Actor) {
    this.validate(input);
    if (input.serverId) await this.servers.row(input.serverId);
    const id = crypto.randomUUID();
    const [row] = await this.db
      .insert(schedules)
      .values({ id, serverId: input.serverId ?? null, name: input.name, cron: input.cron, action: input.action, payload: JSON.stringify(input.payload), enabled: input.enabled, createdAt: Date.now() })
      .returning();
    if (row.enabled) this.scheduler.register(id, row.cron);
    await this.activity.audit(actor, "schedule.create", id, { name: input.name, action: input.action, cron: input.cron });
    return this.toInfo(row);
  }

  async update(id: string, input: z.output<typeof scheduleSchema>, actor: Actor) {
    this.validate(input);
    const [row] = await this.db
      .update(schedules)
      .set({ name: input.name, cron: input.cron, action: input.action, payload: JSON.stringify(input.payload), enabled: input.enabled, serverId: input.serverId ?? null })
      .where(eq(schedules.id, id))
      .returning();
    if (!row) throw notFound("Schedule");
    if (row.enabled) this.scheduler.register(id, row.cron);
    else this.scheduler.unregister(id);
    await this.activity.audit(actor, "schedule.update", id);
    return this.toInfo(row);
  }

  async remove(id: string, actor: Actor) {
    this.scheduler.unregister(id);
    await this.db.delete(scheduleRuns).where(eq(scheduleRuns.scheduleId, id));
    await this.db.delete(schedules).where(eq(schedules.id, id));
    await this.activity.audit(actor, "schedule.delete", id);
  }

  async runNow(id: string, actor: Actor) {
    await this.activity.audit(actor, "schedule.run_now", id);
    await this.fire(id, true);
  }

  /** Register all enabled schedules (idempotent; one timer per id). */
  async boot() {
    for (const r of await this.db.select().from(schedules)) if (r.enabled) this.scheduler.register(r.id, r.cron);
    await this.configureDdns();
  }

  async configureDdns() {
    const s = await this.settings.get();
    if (s.ddnsProvider !== "none" && s.ddnsDomain && s.ddnsToken) this.scheduler.register(DDNS_JOB, "*/10 * * * *");
    else this.scheduler.unregister(DDNS_JOB);
  }

  async updateDdns(): Promise<{ ok: boolean; message: string }> {
    const s = await this.settings.get();
    const provider = DDNS_PROVIDERS[s.ddnsProvider];
    if (!provider) return { ok: false, message: "No DDNS provider configured" };
    const ip = await fetchPublicIp().catch(() => undefined);
    const res = await provider.update({ domain: s.ddnsDomain, token: s.ddnsToken, ip });
    if (ip) await this.settings.set({ publicIp: ip });
    return res;
  }

  private async fire(id: string, manual = false) {
    if (id === DDNS_JOB) {
      const r = await this.updateDdns().catch((e) => ({ ok: false, message: (e as Error).message }));
      if (!r.ok) await this.activity.event(null, "ddns.failed", r.message, { level: "warn" });
      return;
    }
    const [row] = await this.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) return this.scheduler.unregister(id);
    // The unique (schedule, minute) slot prevents duplicate executions.
    const slot = manual ? Date.now() : Math.floor(Date.now() / 60000) * 60000;
    try {
      await this.db.insert(scheduleRuns).values({ scheduleId: id, slot, startedAt: Date.now(), status: "running" });
    } catch {
      return; // already ran for this slot
    }
    let status: "success" | "failed" | "skipped" = "success";
    let output = "";
    try {
      output = (await this.execute(row)) ?? "OK";
      if (output.startsWith("SKIP:")) {
        status = "skipped";
        output = output.slice(5);
      }
    } catch (err) {
      status = "failed";
      output = (err as Error).message;
    }
    await this.db.update(scheduleRuns).set({ finishedAt: Date.now(), status, output: output.slice(0, 2000) }).where(and(eq(scheduleRuns.scheduleId, id), eq(scheduleRuns.slot, slot)));
    await this.db.update(schedules).set({ lastRunAt: Date.now(), lastStatus: status }).where(eq(schedules.id, id));
    await this.activity.event(row.serverId, `schedule.${status}`, `Scheduled task "${row.name}": ${status}${status !== "success" ? ` — ${output}` : ""}`, {
      level: status === "failed" ? "error" : "info",
      actor: SCHEDULER_ACTOR,
    });
  }

  private async execute(row: Row): Promise<string | void> {
    const payload = JSON.parse(row.payload) as { message?: string; command?: string; keep?: number; olderThanDays?: number; warnSeconds?: number };
    const sid = row.serverId!;
    const running = () => this.servers.agent.isRunning(sid);
    switch (row.action) {
      case "start":
        if (running()) return "SKIP:already running";
        await this.servers.start(sid, SCHEDULER_ACTOR);
        return;
      case "stop":
        if (!running()) return "SKIP:not running";
        await this.servers.stop(sid, SCHEDULER_ACTOR);
        return;
      case "restart": {
        if (!running()) return "SKIP:not running";
        const warn = payload.warnSeconds ?? 60;
        if (warn > 0) {
          this.servers.sendCommand(sid, `say Server restarting in ${warn} seconds`);
          await new Promise((r) => setTimeout(r, warn * 1000));
        }
        await this.servers.restart(sid, SCHEDULER_ACTOR);
        return;
      }
      case "backup":
        await this.backups.create(sid, "scheduled", SCHEDULER_ACTOR);
        return;
      case "announce":
        if (!running()) return "SKIP:not running";
        this.servers.sendCommand(sid, `say ${payload.message}`);
        return;
      case "command":
        if (!running()) return "SKIP:not running";
        this.servers.sendCommand(sid, payload.command!);
        return;
      case "prune-backups": {
        const n = await this.backups.applyRetention(sid, payload.keep);
        return `Removed ${n} old backup(s)`;
      }
      case "cleanup-logs": {
        const server = await this.servers.row(sid);
        const dir = path.join(server.directory, "logs");
        const cutoff = Date.now() - (payload.olderThanDays ?? 14) * 86400_000;
        let removed = 0;
        for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
          if (!/\.log\.gz$/.test(f)) continue;
          const st = await fsp.stat(path.join(dir, f));
          if (st.mtimeMs < cutoff) {
            await fsp.rm(path.join(dir, f));
            removed++;
          }
        }
        return `Removed ${removed} log file(s)`;
      }
      default:
        throw new Error(`Unknown action ${row.action}`);
    }
  }

  stop() {
    this.scheduler.stopAll();
  }
}
