import { Cron } from "croner";

export type JobHandler = (jobId: string) => Promise<void>;

/** Validate a 5- or 6-field cron expression; returns an error message or null. */
export function validateCron(expr: string): string | null {
  try {
    const c = new Cron(expr, { paused: true });
    const next = c.nextRun();
    c.stop();
    return next ? null : "This schedule never runs";
  } catch (err) {
    return (err as Error).message;
  }
}

export function nextRuns(expr: string, count = 5): Date[] {
  const c = new Cron(expr, { paused: true });
  const out: Date[] = [];
  let prev: Date | null = null;
  for (let i = 0; i < count; i++) {
    const n = c.nextRun(prev);
    if (!n) break;
    out.push(n);
    prev = n;
  }
  c.stop();
  return out;
}

/**
 * In-process scheduler. Each job id maps to exactly one timer, so
 * re-registering after an application restart never duplicates a job, and
 * `protect` prevents overlapping runs of a slow job.
 */
export class Scheduler {
  private jobs = new Map<string, Cron>();
  private running = new Set<string>();

  constructor(private readonly handler: JobHandler, private readonly onError?: (jobId: string, err: unknown) => void) {}

  register(jobId: string, expr: string): void {
    this.unregister(jobId);
    const job = new Cron(expr, { protect: true, catch: (err) => this.onError?.(jobId, err) }, async () => {
      if (this.running.has(jobId)) return;
      this.running.add(jobId);
      try {
        await this.handler(jobId);
      } catch (err) {
        this.onError?.(jobId, err);
      } finally {
        this.running.delete(jobId);
      }
    });
    this.jobs.set(jobId, job);
  }

  unregister(jobId: string): void {
    this.jobs.get(jobId)?.stop();
    this.jobs.delete(jobId);
  }

  nextRun(jobId: string): Date | null {
    return this.jobs.get(jobId)?.nextRun() ?? null;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  stopAll(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }

  get size(): number {
    return this.jobs.size;
  }
}
