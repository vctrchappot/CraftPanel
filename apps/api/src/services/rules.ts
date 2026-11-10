import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, rules, type Database } from "@craftpanel/database";
import {
  badRequest,
  conditionMet,
  describeAction,
  describeCondition,
  IDLE_RUN,
  isReversible,
  notFound,
  RULE_MAX_PER_SERVER,
  RULE_MIN_GAP_MS,
  ruleProblem,
  ruleSchema,
  SOFTWARE_INFO,
  stepRule,
  type RuleInfo,
  type RuleInput,
  type RuleRun,
  type RuleSnapshot,
} from "@craftpanel/shared";
import { detectHost, freeDiskSpace } from "@craftpanel/server-runtime";
import type { z } from "zod";
import type { ActivityService, Actor } from "./activity";
import type { BackupService } from "./backups";
import type { MapService } from "./map";
import type { NotificationService } from "./notifications";
import type { ServerService } from "./servers";
import { SleepListener } from "./sleep-listener";

type Row = typeof rules.$inferSelect;
type ServerRow = Awaited<ReturnType<ServerService["row"]>>;

const RULES_ACTOR: Actor = { id: null, username: "rules" };
const CHECK_MS = 15_000;
/** TPS readings older than this are treated as unknown. */
const TPS_MAX_AGE_MS = 60_000;
/** After a wake-up, further join attempts within this time don't start the server again. */
const WAKE_GAP_MS = 60_000;

export class RuleService {
  private runs = new Map<string, RuleRun>();
  private sleepers = new Map<string, SleepListener>();
  private lastWake = new Map<string, number>();
  private busy = new Set<string>();
  private watching = new Map<string, () => void>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private db: Database,
    private servers: ServerService,
    private backups: BackupService,
    private maps: MapService,
    private notifications: NotificationService,
    private activity: ActivityService,
  ) {
    // A manual start (or any other) has to find the port free.
    servers.hooks.prepareStart.push((id) => this.disarm(id));
    servers.hooks.deleted.push(async (id) => {
      await this.disarm(id);
      for (const r of await this.db.select().from(rules).where(eq(rules.serverId, id))) this.runs.delete(r.id);
      await this.db.delete(rules).where(eq(rules.serverId, id));
    });
  }

  // ---- storage ----------------------------------------------------------------------

  private definition(r: Row): RuleInput {
    return ruleSchema.parse({ ...JSON.parse(r.definition), name: r.name, enabled: r.enabled });
  }

  private toInfo(r: Row): RuleInfo {
    const { name, enabled, ...rest } = this.definition(r);
    return {
      ...rest,
      name,
      enabled,
      id: r.id,
      serverId: r.serverId,
      active: r.active,
      sleeping: this.sleepers.has(r.serverId) && r.sleeping,
      holdingSince: this.runs.get(r.id)?.since ?? null,
      lastTriggeredAt: r.lastTriggeredAt,
      lastResult: r.lastResult,
      createdAt: r.createdAt,
    };
  }

  private stored(input: RuleInput) {
    const { name, enabled, ...rest } = input;
    return { name, enabled, definition: JSON.stringify(rest) };
  }

  async list(serverId: string): Promise<RuleInfo[]> {
    const rows = await this.db.select().from(rules).where(eq(rules.serverId, serverId)).orderBy(rules.createdAt);
    return rows.map((r) => this.toInfo(r));
  }

  /** The server a rule belongs to. */
  async serverIdOf(id: string): Promise<string> {
    const [row] = await this.db.select({ serverId: rules.serverId }).from(rules).where(eq(rules.id, id));
    if (!row) throw notFound("Rule");
    return row.serverId;
  }

  private async validate(serverId: string, input: z.output<typeof ruleSchema>) {
    const row = await this.servers.row(serverId);
    const problem = ruleProblem(input);
    if (problem) throw badRequest(problem);
    if (SOFTWARE_INFO[row.software].proxy && input.when.kind === "low-tps") throw badRequest("A proxy doesn't tick, so it has no TPS to watch");
  }

  async create(serverId: string, input: z.output<typeof ruleSchema>, actor: Actor): Promise<RuleInfo> {
    await this.validate(serverId, input);
    const existing = await this.db.select({ id: rules.id }).from(rules).where(eq(rules.serverId, serverId));
    if (existing.length >= RULE_MAX_PER_SERVER) throw badRequest(`A server can have up to ${RULE_MAX_PER_SERVER} rules`);
    const id = crypto.randomUUID();
    const [row] = await this.db.insert(rules).values({ id, serverId, ...this.stored(input), createdAt: Date.now() }).returning();
    await this.activity.audit(actor, "rule.create", serverId, { name: input.name });
    return this.toInfo(row!);
  }

  async update(id: string, input: z.output<typeof ruleSchema>, actor: Actor): Promise<RuleInfo> {
    const serverId = await this.serverIdOf(id);
    await this.validate(serverId, input);
    // A changed rule starts over; whatever it had in effect is undone first.
    await this.release(id, serverId).catch(() => undefined);
    this.runs.delete(id);
    const [row] = await this.db.update(rules).set(this.stored(input)).where(eq(rules.id, id)).returning();
    await this.activity.audit(actor, "rule.update", serverId, { name: input.name });
    return this.toInfo(row!);
  }

  async remove(id: string, actor: Actor) {
    const serverId = await this.serverIdOf(id);
    await this.release(id, serverId).catch(() => undefined);
    const [row] = await this.db.select().from(rules).where(eq(rules.id, id));
    this.runs.delete(id);
    await this.db.delete(rules).where(eq(rules.id, id));
    if (row?.sleeping) await this.disarm(serverId);
    await this.activity.audit(actor, "rule.delete", serverId, { name: row?.name });
  }

  // ---- lifecycle --------------------------------------------------------------------

  /** Begin watching, and put sleeping servers back to sleep after CraftPanel was restarted. */
  async start() {
    for (const r of await this.db.select().from(rules).where(eq(rules.sleeping, true))) {
      const row = await this.servers.row(r.serverId).catch(() => null);
      if (row && !this.servers.agent.isRunning(row.id) && row.installState === "installed") await this.arm(row, r.id, true).catch(() => undefined);
      else await this.db.update(rules).set({ sleeping: false }).where(eq(rules.id, r.id));
    }
    this.timer ??= setInterval(() => void this.tick().catch(() => undefined), CHECK_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const release of this.watching.values()) release();
    this.watching.clear();
    // The port goes back to whoever wants it; the next start of CraftPanel puts sleeping servers back to sleep.
    for (const l of this.sleepers.values()) await l.close().catch(() => undefined);
    this.sleepers.clear();
  }

  // ---- evaluation -------------------------------------------------------------------

  private async snapshot(row: ServerRow, needs: { disk: boolean }): Promise<RuleSnapshot> {
    const agent = this.servers.agent;
    const info = agent.info(row.id);
    const m = agent.latestMetrics(row.id);
    const total = detectHost().memoryBytes;
    const free = Math.min(os.freemem(), total);
    const disk = needs.disk ? await freeDiskSpace(row.directory).catch(() => null) : null;
    return {
      players: info.players.length,
      tps: m && m.tps !== null && Date.now() - m.ts < TPS_MAX_AGE_MS ? m.tps : null,
      hostMemoryPercent: total > 0 ? (1 - free / total) * 100 : null,
      diskFreeGb: disk ? disk.free / 1024 ** 3 : null,
      uptimeMs: info.readyAt ? Date.now() - info.readyAt : null,
    };
  }

  /** One pass over every server that has rules. Exposed for tests. */
  async tick(now = Date.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const all = await this.db.select().from(rules);
      const byServer = new Map<string, Row[]>();
      for (const r of all) byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);
      for (const [serverId, list] of byServer) {
        const row = await this.servers.row(serverId).catch(() => null);
        if (!row) continue;
        const live = this.servers.agent.isRunning(serverId) && this.servers.agent.status(serverId) === "running";
        const enabled = list.filter((r) => r.enabled);
        this.syncWatch(serverId, live && enabled.some((r) => this.definition(r).when.kind === "low-tps"));
        if (!live) {
          // Whatever was in effect went away with the process.
          for (const r of list) {
            this.runs.delete(r.id);
            if (r.active) await this.db.update(rules).set({ active: false }).where(eq(rules.id, r.id));
          }
          continue;
        }
        if (this.servers.busy(serverId)) continue;
        const defs = enabled.map((r) => [r, this.definition(r)] as const);
        const snap = await this.snapshot(row, { disk: defs.some(([, d]) => d.when.kind === "low-disk") });
        for (const [r, def] of defs) await this.evaluate(row, r, def, snap, now);
        // A rule that was switched off while its action was in effect lets go of it.
        for (const r of list.filter((x) => !x.enabled && x.active)) await this.release(r.id, serverId).catch(() => undefined);
      }
    } finally {
      this.ticking = false;
    }
  }

  private syncWatch(serverId: string, want: boolean) {
    const held = this.watching.get(serverId);
    if (want && !held) this.watching.set(serverId, this.servers.agent.watch(serverId));
    else if (!want && held) {
      held();
      this.watching.delete(serverId);
    }
  }

  private async evaluate(row: ServerRow, r: Row, def: RuleInput, snap: RuleSnapshot, now: number) {
    if (this.busy.has(r.id)) return;
    const before = this.runs.get(r.id) ?? (r.active ? { since: now, fired: true } : IDLE_RUN);
    const step = stepRule(before, conditionMet(def, snap), now, def.forMinutes * 60_000);
    // A restart that fired a moment ago waits, so a condition that outlasts the restart can't make it loop.
    if (step.fire && def.then.kind === "restart" && r.lastTriggeredAt && now - r.lastTriggeredAt < RULE_MIN_GAP_MS) {
      this.runs.set(r.id, { since: step.run.since, fired: false });
      return;
    }
    this.runs.set(r.id, step.run);
    if (step.release) await this.release(r.id, row.id).catch(() => undefined);
    if (step.fire) {
      this.busy.add(r.id);
      void this.fire(row, r, def)
        .catch(() => undefined)
        .finally(() => this.busy.delete(r.id));
    }
  }

  // ---- actions ----------------------------------------------------------------------

  private async say(row: ServerRow, message: string) {
    await this.servers.sendCommand(row.id, `say ${message}`);
  }

  /** Warn the people who are online and give them time; an empty server gets no countdown. */
  private async warn(row: ServerRow, what: string, seconds: number) {
    if (seconds <= 0 || this.servers.agent.info(row.id).players.length === 0) return;
    await this.say(row, `Server ${what} in ${seconds} seconds`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private async fire(row: ServerRow, r: Row, def: RuleInput) {
    const a = def.then;
    const why = describeCondition(def);
    let result = "Done";
    let failed = false;
    try {
      switch (a.kind) {
        case "stop":
          await this.warn(row, "stopping", a.warnSeconds);
          await this.servers.stop(row.id, RULES_ACTOR);
          result = "Stopped";
          if (a.wake) result = await this.arm(row, r.id).then(() => "Stopped, waits for a player", (e: Error) => `Stopped, but could not wait for players: ${e.message}`);
          break;
        case "restart":
          await this.warn(row, "restarting", a.warnSeconds);
          await this.servers.restart(row.id, RULES_ACTOR);
          result = "Restarted";
          break;
        case "command":
          await this.servers.sendCommand(row.id, a.command);
          break;
        case "announce":
          await this.say(row, a.message);
          break;
        case "backup":
          await this.backups.create(row.id, "scheduled", RULES_ACTOR, `Rule: ${def.name}`);
          result = "Backup created";
          break;
        case "notify": {
          const sent = await this.notifications.send({ title: `Rule “${def.name}”`, message: `${a.message} (${row.name}: ${why.toLowerCase()})`, level: "info", server: row.name });
          if (!sent.length) throw new Error("No notification channel is set up (Settings → Notifications)");
          const bad = sent.filter((s) => !s.ok);
          if (bad.length) throw new Error(bad.map((s) => `${s.channel}: ${s.error}`).join("; "));
          result = "Notification sent";
          break;
        }
        case "pause-map":
          await this.maps.act(row, "pause", RULES_ACTOR);
          result = "Map paused";
          break;
      }
    } catch (err) {
      failed = true;
      result = (err as Error).message;
    }
    const reversible = !failed && isReversible(a);
    await this.db.update(rules).set({ lastTriggeredAt: Date.now(), lastResult: failed ? `Failed: ${result}` : result, active: reversible }).where(eq(rules.id, r.id));
    await this.activity.event(row.id, failed ? "rule.failed" : "rule.fired", `Rule “${def.name}”: ${why}, so ${describeAction(a)}${failed ? ` (failed: ${result})` : ""}`, {
      actor: RULES_ACTOR,
      level: failed ? "warn" : "info",
    });
    // A failed action is tried again the next time the condition starts to hold.
    if (failed) this.runs.set(r.id, { since: null, fired: false });
  }

  /** Undo a reversible action once its condition has ended. */
  private async release(id: string, serverId: string) {
    const [r] = await this.db.select().from(rules).where(and(eq(rules.id, id), eq(rules.active, true)));
    if (!r) return;
    await this.db.update(rules).set({ active: false }).where(eq(rules.id, id));
    const def = this.definition(r);
    const row = await this.servers.row(serverId);
    if (!this.servers.agent.isRunning(serverId)) return;
    const a = def.then;
    if (a.kind === "command" && a.undoCommand) await this.servers.sendCommand(serverId, a.undoCommand);
    else if (a.kind === "pause-map") await this.maps.act(row, "resume", RULES_ACTOR);
    await this.activity.event(serverId, "rule.released", `Rule “${def.name}”: the condition ended, so ${a.kind === "command" ? `“${a.undoCommand}” ran` : "the map renders again"}`, { actor: RULES_ACTOR });
  }

  // ---- sleeping ---------------------------------------------------------------------

  /** Stand on the server's port until a player tries to join. */
  private async arm(row: ServerRow, ruleId: string, quiet = false) {
    await this.disarm(row.id, false);
    const icon = await fsp.readFile(path.join(row.directory, "server-icon.png")).catch(() => null);
    const listener = await SleepListener.open({
      port: row.port,
      host: row.bindAddress || "0.0.0.0",
      versionName: `${SOFTWARE_INFO[row.software].label} ${row.mcVersion}`,
      maxPlayers: row.maxPlayers,
      favicon: icon && icon.length < 100_000 ? `data:image/png;base64,${icon.toString("base64")}` : null,
      onWake: (remote) => void this.wake(row.id, ruleId, remote),
    });
    this.sleepers.set(row.id, listener);
    await this.db.update(rules).set({ sleeping: true }).where(eq(rules.id, ruleId));
    if (!quiet) await this.activity.event(row.id, "server.sleep", "The server is asleep and wakes when a player connects", { actor: RULES_ACTOR });
  }

  /** Let go of the port; the rules forget that the server was asleep. */
  async disarm(serverId: string, clear = true) {
    const l = this.sleepers.get(serverId);
    this.sleepers.delete(serverId);
    if (l) await l.close().catch(() => undefined);
    if (clear) await this.db.update(rules).set({ sleeping: false }).where(and(eq(rules.serverId, serverId), eq(rules.sleeping, true)));
  }

  private async wake(serverId: string, ruleId: string, remote: string) {
    if (!this.sleepers.has(serverId)) return;
    const gap = Date.now() - (this.lastWake.get(serverId) ?? 0);
    if (gap < WAKE_GAP_MS) return;
    this.lastWake.set(serverId, Date.now());
    await this.disarm(serverId);
    await this.activity.event(serverId, "server.wake", `Waking up: a player tried to join from ${remote}`, { actor: RULES_ACTOR });
    try {
      await this.servers.start(serverId, RULES_ACTOR);
    } catch (err) {
      await this.activity.event(serverId, "server.wake_failed", `The server could not wake up: ${(err as Error).message}`, { level: "error", actor: RULES_ACTOR });
      const row = await this.servers.row(serverId).catch(() => null);
      if (row && !this.servers.agent.isRunning(serverId)) await this.arm(row, ruleId, true).catch(() => undefined);
    }
  }
}
