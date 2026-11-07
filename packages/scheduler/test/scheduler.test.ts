import { describe, expect, it } from "vitest";
import { nextRuns, Scheduler, validateCron } from "../src";

describe("scheduler", () => {
  it("validates cron expressions", () => {
    expect(validateCron("0 4 * * *")).toBeNull();
    expect(validateCron("*/30 * * * *")).toBeNull();
    expect(validateCron("not a cron")).not.toBeNull();
    expect(validateCron("61 * * * *")).not.toBeNull();
  });
  it("computes upcoming runs", () => {
    const runs = nextRuns("0 4 * * *", 3);
    expect(runs).toHaveLength(3);
    expect(runs.every((d) => d.getHours() === 4 && d.getMinutes() === 0)).toBe(true);
  });
  it("keeps exactly one timer per job id (no duplicates after re-registering)", () => {
    const s = new Scheduler(async () => {});
    s.register("a", "* * * * *");
    s.register("a", "*/5 * * * *");
    s.register("b", "* * * * *");
    expect(s.size).toBe(2);
    s.unregister("a");
    expect(s.size).toBe(1);
    s.stopAll();
    expect(s.size).toBe(0);
  });
  it("fires handlers and never overlaps a running job", async () => {
    let concurrent = 0;
    let max = 0;
    let calls = 0;
    const s = new Scheduler(async () => {
      calls++;
      concurrent++;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 1500));
      concurrent--;
    });
    s.register("fast", "* * * * * *"); // every second (6-field)
    await new Promise((r) => setTimeout(r, 3500));
    s.stopAll();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(max).toBe(1);
  });
});
