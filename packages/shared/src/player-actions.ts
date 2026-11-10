import { badRequest } from "./errors";
import { playerNameSchema } from "./schemas";

/**
 * Things an operator can do to an online player from the dashboard. Every action is a short list of console
 * commands built here from validated parameters, so the dashboard's forms and the API's checks come from one place.
 */
export type PlayerActionGroup = "manage" | "fun";
/** `harsh` actions hurt the player or take something away; the dashboard asks before running them. */
export type PlayerActionSeverity = "mild" | "harsh";
export type PlayerActionValue = string | number;
export type PlayerActionValues = Record<string, PlayerActionValue>;

export type PlayerActionParam =
  | { key: string; kind: "text"; label: string; max: number; placeholder?: string; optional?: boolean; help?: string }
  | { key: string; kind: "number"; label: string; min: number; max: number; default: number; step?: number; integer?: boolean; unit?: string; help?: string }
  | { key: string; kind: "select"; label: string; options: { value: string; label: string }[]; default: string; /** Also accepts a namespaced id typed by hand. */ custom?: boolean; help?: string }
  | { key: string; kind: "player"; label: string; help?: string };

export interface PlayerActionDef {
  id: string;
  group: PlayerActionGroup;
  severity: PlayerActionSeverity;
  label: string;
  description: string;
  params: PlayerActionParam[];
  /** Console commands, in order. Values are already validated. */
  commands: (name: string, v: PlayerActionValues) => string[];
  /** What was done, in the past tense: the toast and the entry in the player's history. */
  summary: (name: string, v: PlayerActionValues) => string;
}

const ID = /^[a-z0-9_.-]+(:[a-z0-9_./-]+)?$/;
/** Characters that would end or split a console line. */
const CONTROL = new RegExp("[\u0000-\u001f\u007f" + String.fromCharCode(0x2028, 0x2029) + "]");

const mc = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);
const text = (s: string) => JSON.stringify({ text: s });
const num = (n: PlayerActionValue) => String(Number(n));
const str = (v: PlayerActionValues, k: string) => String(v[k] ?? "");

const EFFECTS = [
  ["levitation", "Levitation"],
  ["blindness", "Blindness"],
  ["nausea", "Nausea"],
  ["slowness", "Slowness"],
  ["speed", "Speed"],
  ["jump_boost", "Jump boost"],
  ["slow_falling", "Slow falling"],
  ["night_vision", "Night vision"],
  ["invisibility", "Invisibility"],
  ["glowing", "Glowing"],
  ["hunger", "Hunger"],
  ["poison", "Poison"],
  ["weakness", "Weakness"],
  ["darkness", "Darkness"],
] as const;

const SOUNDS = [
  ["entity.creeper.primed", "Creeper hiss"],
  ["entity.enderman.scream", "Enderman scream"],
  ["entity.ghast.scream", "Ghast scream"],
  ["entity.elder_guardian.curse", "Guardian curse"],
  ["entity.wither.spawn", "Wither spawn"],
  ["entity.lightning_bolt.thunder", "Thunder"],
  ["ambient.cave", "Cave noise"],
  ["block.anvil.land", "Anvil"],
  ["block.bell.use", "Bell"],
  ["entity.player.levelup", "Level up"],
] as const;

const DIMENSIONS = [
  { value: "current", label: "Where they are" },
  { value: "minecraft:overworld", label: "Overworld" },
  { value: "minecraft:the_nether", label: "Nether" },
  { value: "minecraft:the_end", label: "The End" },
];

const COORD = 30_000_000;
const coord = (key: string, label: string): Extract<PlayerActionParam, { kind: "number" }> => ({ key, kind: "number", label, min: -COORD, max: COORD, default: 0, step: 1 });

export const PLAYER_ACTIONS: PlayerActionDef[] = [
  // ---- management ---------------------------------------------------------------------------------
  {
    id: "teleport-player",
    group: "manage",
    severity: "mild",
    label: "Teleport to a player",
    description: "Move them next to another player who is online.",
    params: [{ key: "target", kind: "player", label: "Player" }],
    commands: (n, v) => [`tp ${n} ${str(v, "target")}`],
    summary: (n, v) => `Teleported ${n} to ${str(v, "target")}`,
  },
  {
    id: "teleport-coords",
    group: "manage",
    severity: "mild",
    label: "Teleport to coordinates",
    description: "Send them to a position, optionally in another dimension.",
    params: [coord("x", "X"), { ...coord("y", "Y"), min: -2048, max: 2048, default: 80 }, coord("z", "Z"), { key: "dimension", kind: "select", label: "Dimension", options: DIMENSIONS, default: "current" }],
    commands: (n, v) => {
      const tp = `tp ${n} ${num(v.x)} ${num(v.y)} ${num(v.z)}`;
      return [v.dimension === "current" ? tp : `execute in ${v.dimension} run ${tp}`];
    },
    summary: (n, v) => `Teleported ${n} to ${num(v.x)} ${num(v.y)} ${num(v.z)}${v.dimension === "current" ? "" : ` in ${str(v, "dimension").replace("minecraft:", "")}`}`,
  },
  {
    id: "heal",
    group: "manage",
    severity: "mild",
    label: "Heal and feed",
    description: "Refill health and hunger.",
    params: [],
    commands: (n) => [`effect give ${n} minecraft:instant_health 1 10 true`, `effect give ${n} minecraft:saturation 1 20 true`],
    summary: (n) => `Healed and fed ${n}`,
  },
  {
    id: "gamemode",
    group: "manage",
    severity: "mild",
    label: "Change game mode",
    description: "Switch between survival, creative, adventure and spectator.",
    params: [
      {
        key: "mode",
        kind: "select",
        label: "Game mode",
        default: "survival",
        options: [
          { value: "survival", label: "Survival" },
          { value: "creative", label: "Creative" },
          { value: "adventure", label: "Adventure" },
          { value: "spectator", label: "Spectator" },
        ],
      },
    ],
    commands: (n, v) => [`gamemode ${v.mode} ${n}`],
    summary: (n, v) => `Set ${n} to ${v.mode} mode`,
  },
  {
    id: "give-item",
    group: "manage",
    severity: "mild",
    label: "Give an item",
    description: "Put an item in their inventory; it drops if there is no room.",
    params: [
      { key: "item", kind: "text", label: "Item", max: 80, placeholder: "minecraft:diamond", help: "An item id, with or without the minecraft: prefix." },
      { key: "count", kind: "number", label: "Amount", min: 1, max: 64, default: 1, integer: true },
    ],
    commands: (n, v) => [`give ${n} ${mc(str(v, "item"))} ${num(v.count)}`],
    summary: (n, v) => `Gave ${n} ${num(v.count)} × ${mc(str(v, "item"))}`,
  },
  {
    id: "set-xp",
    group: "manage",
    severity: "mild",
    label: "Set experience level",
    description: "Replace their level; the progress bar to the next level resets.",
    params: [{ key: "level", kind: "number", label: "Level", min: 0, max: 100_000, default: 30, integer: true }],
    commands: (n, v) => [`xp set ${n} ${num(v.level)} levels`],
    summary: (n, v) => `Set ${n} to experience level ${num(v.level)}`,
  },
  {
    id: "clear-effects",
    group: "manage",
    severity: "mild",
    label: "Remove all effects",
    description: "End every potion and status effect they have.",
    params: [],
    commands: (n) => [`effect clear ${n}`],
    summary: (n) => `Removed all effects from ${n}`,
  },
  {
    id: "message",
    group: "manage",
    severity: "mild",
    label: "Send a private message",
    description: "Shown in their chat; nobody else sees it.",
    params: [{ key: "text", kind: "text", label: "Message", max: 256 }],
    commands: (n, v) => [`tellraw ${n} ${text(str(v, "text"))}`],
    summary: (n) => `Sent ${n} a private message`,
  },
  {
    id: "clear-inventory",
    group: "manage",
    severity: "harsh",
    label: "Clear inventory",
    description: "Delete everything they carry, armor and offhand included. The ender chest stays.",
    params: [],
    commands: (n) => [`clear ${n}`],
    summary: (n) => `Cleared the inventory of ${n}`,
  },

  // ---- fun ----------------------------------------------------------------------------------------
  {
    id: "title",
    group: "fun",
    severity: "mild",
    label: "Show a title",
    description: "Big text in the middle of their screen.",
    params: [
      { key: "title", kind: "text", label: "Title", max: 60 },
      { key: "subtitle", kind: "text", label: "Subtitle", max: 80, optional: true },
      { key: "seconds", kind: "number", label: "Visible for", min: 1, max: 20, default: 4, integer: true, unit: "s" },
    ],
    commands: (n, v) => [
      `title ${n} times 10 ${Number(v.seconds) * 20} 20`,
      // The subtitle is queued first so it appears together with the title.
      ...(str(v, "subtitle") ? [`title ${n} subtitle ${text(str(v, "subtitle"))}`] : []),
      `title ${n} title ${text(str(v, "title"))}`,
    ],
    summary: (n, v) => `Showed ${n} the title “${str(v, "title")}”`,
  },
  {
    id: "sound",
    group: "fun",
    severity: "mild",
    label: "Play a sound",
    description: "Only they hear it, as if it came from right next to them.",
    params: [
      { key: "sound", kind: "select", label: "Sound", options: SOUNDS.map(([value, label]) => ({ value, label })), default: SOUNDS[0][0], custom: true, help: "Pick one or type a sound id." },
      { key: "pitch", kind: "number", label: "Pitch", min: 0.5, max: 2, default: 1, step: 0.1 },
    ],
    commands: (n, v) => [`execute at ${n} run playsound ${mc(str(v, "sound"))} master ${n} ~ ~ ~ 1 ${num(v.pitch)}`],
    summary: (n, v) => `Played ${mc(str(v, "sound"))} for ${n}`,
  },
  {
    id: "effect",
    group: "fun",
    severity: "mild",
    label: "Apply an effect",
    description: "A potion effect for a while; it shows its icon and particles.",
    params: [
      { key: "effect", kind: "select", label: "Effect", options: EFFECTS.map(([value, label]) => ({ value, label })), default: "levitation", custom: true },
      { key: "seconds", kind: "number", label: "Duration", min: 1, max: 600, default: 10, integer: true, unit: "s" },
      { key: "level", kind: "number", label: "Level", min: 1, max: 10, default: 1, integer: true },
    ],
    commands: (n, v) => [`effect give ${n} ${mc(str(v, "effect"))} ${num(v.seconds)} ${Number(v.level) - 1}`],
    summary: (n, v) => `Gave ${n} ${mc(str(v, "effect")).replace("minecraft:", "")} ${num(v.level)} for ${num(v.seconds)} s`,
  },
  {
    id: "fake-op",
    group: "fun",
    severity: "mild",
    label: "Fake operator message",
    description: "Shows “Made … a server operator” in their chat. Nothing changes.",
    params: [],
    commands: (n) => [`tellraw ${n} ${JSON.stringify({ text: `[Server: Made ${n} a server operator]`, color: "gray", italic: true })}`],
    summary: (n) => `Sent ${n} a fake operator message`,
  },
  {
    id: "launch",
    group: "fun",
    severity: "harsh",
    label: "Launch into the air",
    description: "Lift them up fast. Then they fall: from high up that hurts.",
    params: [{ key: "seconds", kind: "number", label: "Lift time", min: 1, max: 5, default: 2, integer: true, unit: "s", help: "About 15 blocks per second." }],
    commands: (n, v) => [`effect give ${n} minecraft:levitation ${num(v.seconds)} 14 true`],
    summary: (n, v) => `Launched ${n} into the air for ${num(v.seconds)} s`,
  },
  {
    id: "lightning",
    group: "fun",
    severity: "harsh",
    label: "Strike with lightning",
    description: "A real bolt on their position: damage, fire and noise.",
    params: [],
    commands: (n) => [`execute at ${n} run summon minecraft:lightning_bolt`],
    summary: (n) => `Struck ${n} with lightning`,
  },
  {
    id: "kill",
    group: "fun",
    severity: "harsh",
    label: "Kill",
    description: "They die and drop their items, unless keepInventory is on.",
    params: [],
    commands: (n) => [`kill ${n}`],
    summary: (n) => `Killed ${n}`,
  },
];

export const PLAYER_ACTION_BY_ID = new Map(PLAYER_ACTIONS.map((a) => [a.id, a]));

/** Checks `raw` against an action's parameters and returns clean values; throws a 400 naming the first bad one. */
export function resolvePlayerActionValues(def: PlayerActionDef, raw: unknown): PlayerActionValues {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: PlayerActionValues = {};
  for (const p of def.params) {
    const v = input[p.key];
    if (p.kind === "text") {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s && !p.optional) throw badRequest(`${p.label} is required`);
      if (s.length > p.max) throw badRequest(`${p.label} can have at most ${p.max} characters`);
      if (CONTROL.test(s)) throw badRequest(`${p.label} must be a single line`);
      // Item ids are the one free-text value that is not a message: keep them to the id alphabet.
      if (p.key === "item" && !ID.test(s)) throw badRequest("That is not an item id", "Use something like minecraft:diamond.");
      out[p.key] = s;
    } else if (p.kind === "number") {
      const n = v === undefined || v === "" ? p.default : Number(v);
      if (!Number.isFinite(n) || n < p.min || n > p.max) throw badRequest(`${p.label} must be between ${p.min} and ${p.max}`);
      if (p.integer && !Number.isInteger(n)) throw badRequest(`${p.label} must be a whole number`);
      out[p.key] = n;
    } else if (p.kind === "select") {
      const s = typeof v === "string" && v ? v.trim() : p.default;
      const known = p.options.some((o) => o.value === s);
      // A typed id is only taken where the form offers one, and only in the id alphabet.
      if (!known && !(p.custom && ID.test(s))) throw badRequest(`${p.label} is not valid`);
      out[p.key] = s;
    } else {
      const parsed = playerNameSchema.safeParse(v);
      if (!parsed.success) throw badRequest(`${p.label} must be a Minecraft username`);
      out[p.key] = parsed.data;
    }
  }
  return out;
}

/** The checked commands and the summary for one action on one player. */
export function planPlayerAction(id: string, name: string, raw: unknown): { def: PlayerActionDef; values: PlayerActionValues; commands: string[]; summary: string } {
  const def = PLAYER_ACTION_BY_ID.get(id);
  if (!def) throw badRequest("Unknown player action");
  const values = resolvePlayerActionValues(def, raw);
  return { def, values, commands: def.commands(name, values), summary: def.summary(name, values) };
}

// ---- inspection -----------------------------------------------------------------------------------

/** What Minecraft and plugins keep about a player beyond the profile: abilities, scoreboard tags, effects, plugin data. */
export interface PlayerInspect {
  /** `game`: asked of the running game just now. `file`: the last saved player file. */
  source: "game" | "file";
  savedAt: number | null;
  flags: { id: string; label: string; on: boolean }[];
  values: { label: string; value: string }[];
  tags: string[];
  effects: { id: string; level: number; seconds: number | null }[];
  /** Data plugins store on the player, by plugin namespace. Paper only. */
  plugins: { namespace: string; entries: { key: string; value: string }[] }[];
  /** The player's data as formatted JSON, without inventory, ender chest and recipe book. */
  raw: string;
}
