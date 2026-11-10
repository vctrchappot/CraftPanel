import { describe, expect, it } from "vitest";
import { conditionMet, describeAction, describeCondition, IDLE_RUN, isReversible, ruleProblem, ruleSchema, stepRule, type RuleInput, type RuleSnapshot } from "../src/rules";

const snap = (patch: Partial<RuleSnapshot> = {}): RuleSnapshot => ({ players: 0, tps: 20, hostMemoryPercent: 40, diskFreeGb: 50, uptimeMs: 3600_000, ...patch });
const rule = (patch: Partial<RuleInput> = {}): RuleInput => ruleSchema.parse({ name: "r", when: { kind: "empty" }, forMinutes: 10, then: { kind: "stop" }, ...patch });

describe("rule conditions", () => {
  it("checks each reading against its limit", () => {
    expect(conditionMet(rule(), snap())).toBe(true);
    expect(conditionMet(rule(), snap({ players: 1 }))).toBe(false);
    expect(conditionMet(rule({ when: { kind: "low-tps", below: 15 } }), snap({ tps: 12 }))).toBe(true);
    expect(conditionMet(rule({ when: { kind: "low-tps", below: 15 } }), snap({ tps: 15 }))).toBe(false);
    expect(conditionMet(rule({ when: { kind: "host-memory", abovePercent: 90 } }), snap({ hostMemoryPercent: 95 }))).toBe(true);
    expect(conditionMet(rule({ when: { kind: "low-disk", belowGb: 5 } }), snap({ diskFreeGb: 2 }))).toBe(true);
    expect(conditionMet(rule({ when: { kind: "uptime", hours: 24 } }), snap({ uptimeMs: 25 * 3600_000 }))).toBe(true);
    expect(conditionMet(rule({ when: { kind: "uptime", hours: 24 } }), snap({ uptimeMs: 23 * 3600_000 }))).toBe(false);
  });
  it("never counts a missing reading as met", () => {
    expect(conditionMet(rule({ when: { kind: "low-tps", below: 15 } }), snap({ tps: null }))).toBe(false);
    expect(conditionMet(rule({ when: { kind: "host-memory", abovePercent: 90 } }), snap({ hostMemoryPercent: null }))).toBe(false);
    expect(conditionMet(rule({ when: { kind: "low-disk", belowGb: 5 } }), snap({ diskFreeGb: null }))).toBe(false);
    expect(conditionMet(rule({ when: { kind: "uptime", hours: 1 } }), snap({ uptimeMs: null }))).toBe(false);
  });
  it("can be limited to an empty server", () => {
    const r = rule({ when: { kind: "low-tps", below: 15 }, onlyIfEmpty: true });
    expect(conditionMet(r, snap({ tps: 5, players: 2 }))).toBe(false);
    expect(conditionMet(r, snap({ tps: 5, players: 0 }))).toBe(true);
  });
});

describe("rule timing", () => {
  const MIN = 60_000;
  it("fires once after the condition held long enough, then waits for it to end", () => {
    let run = IDLE_RUN;
    let step = stepRule(run, true, 0, 10 * MIN);
    expect(step.fire).toBe(false);
    run = step.run;
    step = stepRule(run, true, 9 * MIN, 10 * MIN);
    expect(step.fire).toBe(false);
    run = step.run;
    step = stepRule(run, true, 10 * MIN, 10 * MIN);
    expect(step.fire).toBe(true);
    run = step.run;
    step = stepRule(run, true, 30 * MIN, 10 * MIN);
    expect(step).toMatchObject({ fire: false, release: false });
    run = step.run;
    step = stepRule(run, false, 31 * MIN, 10 * MIN);
    expect(step).toMatchObject({ fire: false, release: true });
    expect(step.run).toEqual(IDLE_RUN);
  });
  it("starts over when the condition breaks before the time is up", () => {
    let step = stepRule(IDLE_RUN, true, 0, 10 * MIN);
    step = stepRule(step.run, false, 5 * MIN, 10 * MIN);
    expect(step).toMatchObject({ fire: false, release: false });
    step = stepRule(step.run, true, 6 * MIN, 10 * MIN);
    step = stepRule(step.run, true, 15 * MIN, 10 * MIN);
    expect(step.fire).toBe(false);
    step = stepRule(step.run, true, 16 * MIN, 10 * MIN);
    expect(step.fire).toBe(true);
  });
  it("fires at once without a hold time", () => {
    expect(stepRule(IDLE_RUN, true, 5, 0).fire).toBe(true);
  });
});

describe("rule definitions", () => {
  it("fills in defaults and rejects values out of range", () => {
    expect(rule({ then: { kind: "stop", warnSeconds: 30, wake: false } }).then).toEqual({ kind: "stop", warnSeconds: 30, wake: false });
    expect(ruleSchema.safeParse({ name: "x", when: { kind: "low-tps", below: 25 }, forMinutes: 1, then: { kind: "backup" } }).success).toBe(false);
    expect(ruleSchema.safeParse({ name: "x", when: { kind: "empty" }, forMinutes: 1, then: { kind: "command", command: "" } }).success).toBe(false);
    expect(ruleSchema.safeParse({ name: "x", when: { kind: "empty" }, forMinutes: 2000, then: { kind: "backup" } }).success).toBe(false);
    expect(ruleSchema.safeParse({ name: "x", when: { kind: "nope" }, forMinutes: 1, then: { kind: "backup" } }).success).toBe(false);
  });
  it("explains what makes a rule unusable", () => {
    expect(ruleProblem(rule())).toBeNull();
    expect(ruleProblem(rule({ forMinutes: 0 }))).toMatch(/at least one minute/);
    expect(ruleProblem(rule({ when: { kind: "low-tps", below: 10 }, then: { kind: "stop", warnSeconds: 0, wake: true } }))).toMatch(/wake/);
    expect(ruleProblem(rule({ when: { kind: "low-tps", below: 10 }, onlyIfEmpty: true, then: { kind: "stop", warnSeconds: 0, wake: true } }))).toBeNull();
    expect(ruleProblem(rule({ then: { kind: "command", command: "say a\nstop" } }))).toMatch(/single line/);
    expect(ruleProblem(rule({ then: { kind: "announce", message: "a\r\nb" } }))).toMatch(/single line/);
  });
  it("knows which actions are undone", () => {
    expect(isReversible({ kind: "pause-map" })).toBe(true);
    expect(isReversible({ kind: "command", command: "tick freeze", undoCommand: "tick unfreeze" })).toBe(true);
    expect(isReversible({ kind: "command", command: "save-all" })).toBe(false);
    expect(isReversible({ kind: "stop", warnSeconds: 0, wake: false })).toBe(false);
  });
  it("reads back as a sentence", () => {
    expect(describeCondition(rule())).toBe("Nobody is online for 10 minutes");
    expect(describeCondition(rule({ when: { kind: "low-tps", below: 12 }, forMinutes: 1, onlyIfEmpty: true }))).toBe("TPS is below 12 for 1 minute, and nobody is online");
    expect(describeCondition(rule({ when: { kind: "uptime", hours: 24 }, forMinutes: 0 }))).toBe("The server has been running for 24 hours");
    expect(describeAction({ kind: "stop", warnSeconds: 0, wake: true })).toBe("stop the server and wake it when a player connects");
  });
});
