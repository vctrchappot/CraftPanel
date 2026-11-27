import crypto from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, jobs, type Database } from "@craftpanel/database";
import type { JobInfo, JobKind } from "@craftpanel/shared";
import type { Hub } from "../hub";
import type { Actor } from "./activity";

type JobRow = typeof jobs.$inferSelect;

/** Finished jobs older than this are dropped. */
export const JOB_RETENTION_MS = 30 * 86_400_000;
/** Progress reaches dashboards at most this often, and the database at most every {@link SAVE_MS}. */
const SEND_MS = 500;
const SAVE_MS = 5_000;
/** A job resumed after a restart is not resumed a second time: whatever ended the dashboard may do so again. */
export const MAX_ATTEMPTS = 2;

export interface JobHandle {
  readonly id: string;
  readonly attempt: number;
  /** Reports a stage and, if known, how far it is (0–100). */
  progress(stage: string, percent?: number | null): void;
}

export interface JobSpec {
  kind: JobKind;
  serverId: string | null;
  title: string;
  actor: Actor;
  /** The interrupted job this run continues (given to `JobRecovery.resume`), instead of a new one. */
  resume?: JobInfo;
}

/**
 * What happens to a job of this kind that was running when the dashboard stopped: `resume` starts the work again
 * (it must be safe to repeat) and passes the job on as `JobSpec.resume`; without it, or when it returns false, the
 * job is marked interrupted with `hint`.
 */
export interface JobRecovery {
  hint: string;
  resume?: (job: JobInfo) => Promise<boolean>;
  /** Removes what an interrupted job of this kind left behind (runs before it is marked interrupted). */
  cleanup?: (job: JobInfo) => Promise<void>;
}

export const toJobInfo = (r: JobRow): JobInfo => ({
  id: r.id,
  kind: r.kind as JobKind,
  serverId: r.serverId,
  title: r.title,
  actor: r.actor,
  state: r.state,
  stage: r.stage,
  percent: r.percent,
  error: r.error,
  hint: r.hint,
  attempt: r.attempt,
  startedAt: r.startedAt,
  updatedAt: r.updatedAt,
  finishedAt: r.finishedAt,
});

/**
 * Records long operations (installs, backups, restores, application backups) as jobs: dashboards see their
 * stage and progress live, the list shows how they ended, and a job that was running when the dashboard stopped
 * is resumed if its kind allows it, or marked interrupted with what to do.
 */
export class JobService {
  /** Jobs running in this process, with when they were last sent and saved. */
  private live = new Map<string, { info: JobInfo; sentAt: number; savedAt: number; pending: NodeJS.Timeout | null }>();
  private recoveries = new Map<JobKind, JobRecovery>();

  constructor(
    private db: Database,
    private hub: Hub,
    private now: () => number = Date.now,
  ) {}

  /** Registers what to do with interrupted jobs of a kind (call before `recover`). */
  onInterrupted(kind: JobKind, recovery: JobRecovery) {
    this.recoveries.set(kind, recovery);
  }

  /** Runs `fn` as a job; its result or error is passed through. */
  async run<T>(spec: JobSpec, fn: (job: JobHandle) => Promise<T>): Promise<T> {
    const now = this.now();
    const resumed = spec.resume;
    const info: JobInfo = resumed
      ? { ...resumed, title: spec.title, state: "running", stage: "Resuming after a restart", percent: null, error: null, hint: null, attempt: resumed.attempt + 1, updatedAt: now, finishedAt: null }
      : { id: crypto.randomUUID(), kind: spec.kind, serverId: spec.serverId, title: spec.title, actor: spec.actor.username, state: "running", stage: null, percent: null, error: null, hint: null, attempt: 1, startedAt: now, updatedAt: now, finishedAt: null };
    if (resumed) await this.db.update(jobs).set(this.columns(info)).where(eq(jobs.id, info.id));
    else await this.db.insert(jobs).values(this.columns(info));
    const entry = { info, sentAt: now, savedAt: now, pending: null as NodeJS.Timeout | null };
    this.live.set(info.id, entry);
    this.send(info);

    const handle: JobHandle = {
      id: info.id,
      attempt: info.attempt,
      progress: (stage, percent = null) => {
        const t = this.now();
        const changed = stage !== info.stage;
        info.stage = stage;
        info.percent = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
        info.updatedAt = t;
        if (changed || t - entry.sentAt >= SEND_MS) {
          entry.sentAt = t;
          this.send(info);
        } else entry.pending ??= setTimeout(() => {
          entry.pending = null;
          entry.sentAt = this.now();
          if (this.live.has(info.id)) this.send(info);
        }, SEND_MS);
        if (changed || t - entry.savedAt >= SAVE_MS) {
          entry.savedAt = t;
          void this.db.update(jobs).set({ stage: info.stage, percent: info.percent, updatedAt: t }).where(eq(jobs.id, info.id)).catch(() => undefined);
        }
      },
    };

    try {
      const result = await fn(handle);
      await this.finish(info, { state: "succeeded", percent: 100 });
      return result;
    } catch (err) {
      await this.finish(info, { state: "failed", error: (err as Error).message });
      throw err;
    }
  }

  private async finish(info: JobInfo, end: Partial<JobInfo>) {
    const entry = this.live.get(info.id);
    if (entry?.pending) clearTimeout(entry.pending);
    this.live.delete(info.id);
    Object.assign(info, end, { updatedAt: this.now(), finishedAt: this.now() });
    await this.db.update(jobs).set(this.columns(info)).where(eq(jobs.id, info.id)).catch(() => undefined);
    this.send(info);
  }

  private columns(i: JobInfo) {
    return { id: i.id, kind: i.kind, serverId: i.serverId, title: i.title, actor: i.actor, state: i.state, stage: i.stage, percent: i.percent, error: i.error, hint: i.hint, attempt: i.attempt, startedAt: i.startedAt, updatedAt: i.updatedAt, finishedAt: i.finishedAt };
  }

  /** Server jobs go to everyone who sees the server; application jobs only to owners. */
  private send(job: JobInfo) {
    const msg = { type: "job" as const, serverId: job.serverId, job: { ...job } };
    if (job.serverId) this.hub.broadcast(msg);
    else this.hub.toOwners(msg);
  }

  /**
   * After a start of the dashboard: jobs still marked running belong to the process that stopped. Each is resumed
   * when its kind allows it (once), otherwise marked interrupted.
   */
  async recover() {
    const stale = (await this.db.select().from(jobs).where(eq(jobs.state, "running"))).filter((r) => !this.live.has(r.id));
    for (const row of stale) {
      const job = toJobInfo(row);
      const recovery = this.recoveries.get(job.kind);
      if (recovery?.resume && job.attempt < MAX_ATTEMPTS) {
        // A resume that started the work continues this job through `run` (also later: the work may await first).
        // If it fails before reaching `run`, the job stays running and the next start of the dashboard handles it.
        if (!(await recovery.resume(job).catch(() => false))) await this.interrupt(job, recovery.hint);
        continue;
      }
      await this.interrupt(job, recovery?.hint ?? "Start it again.");
    }
  }

  private async interrupt(job: JobInfo, hint: string) {
    await this.recoveries.get(job.kind)?.cleanup?.(job).catch(() => undefined);
    const t = this.now();
    const info: JobInfo = { ...job, state: "interrupted", error: "CraftPanel stopped while this was running", hint, updatedAt: t, finishedAt: t };
    await this.db.update(jobs).set(this.columns(info)).where(eq(jobs.id, job.id));
    this.send(info);
  }

  /**
   * Running jobs first, then the newest. `onlyServers` limits a user who sees only some servers; `app` adds
   * application-wide jobs (owners).
   */
  async list(opts: { serverId?: string; onlyServers: string[] | null; app: boolean; limit?: number }): Promise<JobInfo[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const servers = opts.onlyServers ? (opts.onlyServers.length ? inArray(jobs.serverId, opts.onlyServers) : eq(jobs.serverId, "")) : isNotNull(jobs.serverId);
    const scope = opts.serverId ? eq(jobs.serverId, opts.serverId) : opts.app ? or(servers, isNull(jobs.serverId)) : servers;
    const running = await this.db.select().from(jobs).where(and(scope, eq(jobs.state, "running"))).orderBy(desc(jobs.startedAt));
    const done = await this.db.select().from(jobs).where(and(scope, ne(jobs.state, "running"))).orderBy(desc(jobs.startedAt)).limit(limit);
    return [...running, ...done].slice(0, Math.max(limit, running.length)).map((r) => {
      const live = this.live.get(r.id);
      return live ? { ...live.info } : toJobInfo(r);
    });
  }

  async get(id: string): Promise<JobInfo | null> {
    const live = this.live.get(id);
    if (live) return { ...live.info };
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    return row ? toJobInfo(row) : null;
  }

  async forgetServer(serverId: string) {
    await this.db.delete(jobs).where(and(eq(jobs.serverId, serverId), ne(jobs.state, "running")));
  }

  async prune(now = this.now()) {
    await this.db.delete(jobs).where(and(ne(jobs.state, "running"), lt(jobs.startedAt, now - JOB_RETENTION_MS)));
  }
}
