/**
 * The message of the day players see in Minecraft's multiplayer list: up to two lines of text with legacy `§` colour
 * and format codes. These helpers parse and write that text so the dashboard can show a faithful preview and edit it
 * with buttons instead of typing codes by hand.
 */

/** The sixteen colours of the game's legacy codes (`§0`–`§f`). The values are the game's own, not panel tokens. */
export const MOTD_COLORS = [
  { code: "0", name: "Black", hex: "#000000" },
  { code: "1", name: "Dark blue", hex: "#0000aa" },
  { code: "2", name: "Dark green", hex: "#00aa00" },
  { code: "3", name: "Dark aqua", hex: "#00aaaa" },
  { code: "4", name: "Dark red", hex: "#aa0000" },
  { code: "5", name: "Dark purple", hex: "#aa00aa" },
  { code: "6", name: "Gold", hex: "#ffaa00" },
  { code: "7", name: "Gray", hex: "#aaaaaa" },
  { code: "8", name: "Dark gray", hex: "#555555" },
  { code: "9", name: "Blue", hex: "#5555ff" },
  { code: "a", name: "Green", hex: "#55ff55" },
  { code: "b", name: "Aqua", hex: "#55ffff" },
  { code: "c", name: "Red", hex: "#ff5555" },
  { code: "d", name: "Light purple", hex: "#ff55ff" },
  { code: "e", name: "Yellow", hex: "#ffff55" },
  { code: "f", name: "White", hex: "#ffffff" },
] as const;

export const MOTD_FORMATS = [
  { code: "l", name: "Bold", key: "bold" },
  { code: "o", name: "Italic", key: "italic" },
  { code: "n", name: "Underline", key: "underline" },
  { code: "m", name: "Strikethrough", key: "strike" },
  { code: "k", name: "Obfuscated", key: "obfuscated" },
] as const;

export type MotdFormatKey = (typeof MOTD_FORMATS)[number]["key"];

export const MOTD_MAX_LINES = 2;
/** Raw characters including the two a code takes; the server list cuts off anything beyond two lines anyway. */
export const MOTD_MAX_LENGTH = 256;

export interface MotdStyle {
  /** Colour code (`0`–`f`) or null for the default (white in the list). */
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  obfuscated: boolean;
}

export interface MotdSegment extends MotdStyle {
  text: string;
}

const PLAIN: MotdStyle = { color: null, bold: false, italic: false, underline: false, strike: false, obfuscated: false };
const COLOR_CODES = new Set<string>(MOTD_COLORS.map((c) => c.code));
const FORMAT_BY_CODE = new Map<string, MotdFormatKey>(MOTD_FORMATS.map((f) => [f.code, f.key]));

export const motdColor = (code: string | null) => MOTD_COLORS.find((c) => c.code === code) ?? null;

/**
 * Split a message into lines of styled segments. As in the game, a colour code clears the formats before it, `§r`
 * clears everything, a style carries on across the line break, and an unknown code is dropped.
 */
export function parseMotd(raw: string): MotdSegment[][] {
  const lines: MotdSegment[][] = [[]];
  let style: MotdStyle = { ...PLAIN };
  let text = "";
  const flush = () => {
    if (text) lines[lines.length - 1].push({ ...style, text });
    text = "";
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "§") {
      if (i + 1 >= raw.length) continue;
      const code = raw[++i].toLowerCase();
      const format = FORMAT_BY_CODE.get(code);
      if (COLOR_CODES.has(code)) {
        flush();
        style = { ...PLAIN, color: code };
      } else if (code === "r") {
        flush();
        style = { ...PLAIN };
      } else if (format) {
        flush();
        style = { ...style, [format]: true };
      }
    } else if (c === "\n") {
      flush();
      lines.push([]);
    } else {
      text += c;
    }
  }
  flush();
  return lines;
}

const sameStyle = (a: MotdStyle, b: MotdStyle) => a.color === b.color && MOTD_FORMATS.every((f) => a[f.key] === b[f.key]);

/** Write segments back as the shortest sensible code sequence (a reset only where a format has to be dropped). */
export function serializeMotd(lines: MotdSegment[][]): string {
  let out = "";
  let current: MotdStyle = { ...PLAIN };
  lines.forEach((segments, i) => {
    if (i > 0) out += "\n";
    for (const seg of segments) {
      if (!seg.text) continue;
      if (!sameStyle(current, seg)) {
        const dropsFormat = MOTD_FORMATS.some((f) => current[f.key] && !seg[f.key]);
        const dropsColor = current.color !== null && seg.color === null;
        let base: MotdStyle = current;
        if (dropsFormat || dropsColor) {
          out += "§r";
          base = { ...PLAIN };
        }
        // A colour code clears formats in the game, so write the colour first and the formats after it.
        if (seg.color !== base.color) {
          out += `§${seg.color}`;
          base = { ...PLAIN, color: seg.color };
        }
        for (const f of MOTD_FORMATS) if (seg[f.key] && !base[f.key]) out += `§${f.code}`;
        current = { ...seg };
      }
      out += seg.text;
    }
  });
  return out;
}

/** The text without codes, one entry per line. */
export const motdPlainLines = (raw: string): string[] => parseMotd(raw).map((segments) => segments.map((s) => s.text).join(""));

/** The raw text with every colour and format code removed. */
export const stripMotd = (raw: string): string => motdPlainLines(raw).join("\n");

/** What is wrong with a message, or null: at most two lines, at most {@link MOTD_MAX_LENGTH} raw characters. */
export function motdProblem(raw: string): string | null {
  if (raw.length > MOTD_MAX_LENGTH) return `Too long: ${raw.length} of ${MOTD_MAX_LENGTH} characters (each colour or format code takes two).`;
  if (raw.split("\n").length > MOTD_MAX_LINES) return "The server list shows two lines at most.";
  return null;
}

// ---- editing ---------------------------------------------------------------------------------------------------------

/** How many visible characters come before a position in the raw text (codes don't count, a line break does). */
export function motdPlainOffset(raw: string, rawIndex: number): number {
  let count = 0;
  let i = 0;
  while (i < Math.min(rawIndex, raw.length)) {
    if (raw[i] === "§") i += i + 1 < raw.length ? 2 : 1;
    else {
      count++;
      i++;
    }
  }
  return count;
}

/** The position in the raw text of the visible character at `plain`, after any codes in front of it. */
export function motdRawIndex(raw: string, plain: number): number {
  let count = 0;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "§") {
      i += i + 1 < raw.length ? 2 : 1;
      continue;
    }
    if (count === plain) return i;
    count++;
    i++;
  }
  return raw.length;
}

export interface MotdChange {
  /** Colour code to give the text, keeping its styles. */
  color?: string;
  /** Format to switch on, or off again when all of the text has it already. */
  toggle?: MotdFormatKey;
  /** Remove every colour and style. */
  clear?: boolean;
}

/**
 * Change the colour or style of the visible characters `from`–`to` and write the whole text back with the codes in
 * canonical order. Working on what the text looks like, not on the codes in it, keeps a style from being lost to a colour
 * code placed after it, and keeps the codes from piling up as buttons are pressed.
 */
export function restyleMotd(raw: string, from: number, to: number, change: MotdChange): string {
  const chars: { ch: string; style: MotdStyle }[] = [];
  parseMotd(raw).forEach((segments, li) => {
    if (li > 0) chars.push({ ch: "\n", style: chars.length ? chars[chars.length - 1].style : { ...PLAIN } });
    for (const seg of segments) for (let k = 0; k < seg.text.length; k++) chars.push({ ch: seg.text[k], style: { ...seg, text: undefined } as MotdStyle });
  });
  const picked = chars.slice(from, to).filter((c) => c.ch !== "\n");
  const allHave = change.toggle ? picked.length > 0 && picked.every((c) => c.style[change.toggle!]) : false;
  for (let i = from; i < Math.min(to, chars.length); i++) {
    const c = chars[i];
    if (c.ch === "\n") continue;
    if (change.clear) c.style = { ...PLAIN };
    else {
      if (change.color) c.style = { ...c.style, color: change.color };
      if (change.toggle) c.style = { ...c.style, [change.toggle]: !allHave };
    }
  }
  const lines: MotdSegment[][] = [[]];
  let last: MotdStyle | null = null;
  for (const c of chars) {
    if (c.ch === "\n") {
      lines.push([]);
      continue;
    }
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    if (prev && last && sameStyle(prev, c.style)) prev.text += c.ch;
    else line.push({ ...c.style, text: c.ch });
    last = c.style;
  }
  return serializeMotd(lines);
}
