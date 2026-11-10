import { z } from "zod";

/**
 * Rules: "when this holds for a while, do that". A rule watches one server. Conditions that run out again
 * (players join, the TPS recovers) release reversible actions, such as freezing the game or pausing the map.
 */

export const RULE_MAX_PER_SERVER = 20;
/** A rule never fires twice within this time, so a condition that stays true after a restart can't loop. */
export const RULE_MIN_GAP_MS = 10 * 60_000;

export const ruleConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("low-tps"), below: z.number().min(1).max(19.5) }),
  z.object({ kind: z.literal("host-memory"), abovePercent: z.number().int().min(50).max(99) }),
  z.object({ kind: z.literal("low-disk"), belowGb: z.number().min(0.5).max(1000) }),
  z.object({ kind: z.literal("uptime"), hours: z.number().min(1).max(720) }),
]);

export const ruleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop"), warnSeconds: z.number().int().min(0).max(600).default(30), wake: z.boolean().default(false) }),
  z.object({ kind: z.literal("restart"), warnSeconds: z.number().int().min(0).max(600).default(60) }),
  z.object({ kind: z.literal("command"), command: z.string().trim().min(1).max(1000), undoCommand: z.string().trim().max(1000).optional() }),
  z.object({ kind: z.literal("announce"), message: z.string().trim().min(1).max(256) }),
  z.object({ kind: z.literal("backup") }),
  z.object({ kind: z.literal("notify"), message: z.string().trim().min(1).max(256) }),
  z.object({ kind: z.literal("pause-map") }),
]);

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  when: ruleConditionSchema,
  /** How long the condition has to hold without a break before the action runs. */
  forMinutes: z.number().int().min(0).max(1440),
  /** Only act while nobody is online (for conditions other than "empty", which means that already). */
  onlyIfEmpty: z.boolean().default(false),
  then: ruleActionSchema,
});

export type RuleCondition = z.output<typeof ruleConditionSchema>;
export type RuleAction = z.output<typeof ruleActionSchema>;
export type RuleInput = z.output<typeof ruleSchema>;

export interface RuleInfo extends RuleInput {
  id: string;
  serverId: string;
  /** A reversible action is in effect and waits for the condition to end. */
  active: boolean;
  /** The server was put to sleep by this rule and wakes when a player connects. */
  sleeping: boolean;
  /** Since when the condition has held without a break (null: it doesn't hold right now). */
  holdingSince: number | null;
  lastTriggeredAt: number | null;
  lastResult: string | null;
  createdAt: number;
}

export interface RuleSnapshot {
  players: number;
  tps: number | null;
  hostMemoryPercent: number | null;
  diskFreeGb: number | null;
  uptimeMs: number | null;
}

/** Unknown readings (null) never satisfy a condition: a missing TPS must not stop a server. */
export function conditionMet(rule: Pick<RuleInput, "when" | "onlyIfEmpty">, snap: RuleSnapshot): boolean {
  if (rule.onlyIfEmpty && snap.players > 0) return false;
  const w = rule.when;
  switch (w.kind) {
    case "empty":
      return snap.players === 0;
    case "low-tps":
      return snap.tps !== null && snap.tps < w.below;
    case "host-memory":
      return snap.hostMemoryPercent !== null && snap.hostMemoryPercent > w.abovePercent;
    case "low-disk":
      return snap.diskFreeGb !== null && snap.diskFreeGb < w.belowGb;
    case "uptime":
      return snap.uptimeMs !== null && snap.uptimeMs > w.hours * 3600_000;
  }
}

/** An action that is undone when the condition ends. */
export function isReversible(action: RuleAction): boolean {
  return action.kind === "pause-map" || (action.kind === "command" && !!action.undoCommand);
}

export interface RuleRun {
  /** When the condition started to hold without a break. */
  since: number | null;
  /** The action ran for this stretch and waits for the condition to end. */
  fired: boolean;
}

export const IDLE_RUN: RuleRun = { since: null, fired: false };

/** One evaluation: returns the next state and whether to run the action or to undo it. */
export function stepRule(run: RuleRun, met: boolean, now: number, forMs: number): { run: RuleRun; fire: boolean; release: boolean } {
  if (!met) return { run: IDLE_RUN, fire: false, release: run.fired };
  const since = run.since ?? now;
  if (!run.fired && now - since >= forMs) return { run: { since, fired: true }, fire: true, release: false };
  return { run: { since, fired: run.fired }, fire: false, release: false };
}

/** What is wrong with a rule that passed the schema, or null. */
export function ruleProblem(rule: RuleInput): string | null {
  const { when, then } = rule;
  if (when.kind === "empty" && rule.forMinutes < 1) return "Waiting for an empty server needs at least one minute, otherwise it would act the moment the last player leaves";
  if (then.kind === "command" && /[\r\n]/.test(then.command + (then.undoCommand ?? ""))) return "A command must be a single line";
  if ((then.kind === "announce" || then.kind === "notify") && /[\r\n]/.test(then.message)) return "A message must be a single line";
  if (then.kind === "stop" && then.wake && when.kind !== "empty" && !rule.onlyIfEmpty) return "A server can only wake on connect when it was put to sleep because nobody was there: use \"Nobody is online\" or \"only while nobody is online\"";
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeCondition(rule: Pick<RuleInput, "when" | "forMinutes" | "onlyIfEmpty">): string {
  const w = rule.when;
  const base =
    w.kind === "empty" ? "Nobody is online"
    : w.kind === "low-tps" ? `TPS is below ${w.below}`
    : w.kind === "host-memory" ? `Machine memory is above ${w.abovePercent} %`
    : w.kind === "low-disk" ? `Free disk space is below ${w.belowGb} GB`
    : `The server has been running for ${plural(w.hours, "hour")}`;
  const hold = w.kind === "uptime" || rule.forMinutes === 0 ? "" : ` for ${plural(rule.forMinutes, "minute")}`;
  return `${base}${hold}${rule.onlyIfEmpty && w.kind !== "empty" ? ", and nobody is online" : ""}`;
}

export function describeAction(a: RuleAction): string {
  switch (a.kind) {
    case "stop": return a.wake ? "stop the server and wake it when a player connects" : "stop the server";
    case "restart": return "restart the server";
    case "command": return a.undoCommand ? `run “${a.command}”, and “${a.undoCommand}” when it ends` : `run “${a.command}”`;
    case "announce": return "announce it in chat";
    case "backup": return "create a backup";
    case "notify": return "send a notification";
    case "pause-map": return "pause the map renderer until it ends";
  }
}
