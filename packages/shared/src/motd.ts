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
/** Raw characters including the two a colour or style code takes and the fourteen of a smooth colour. */
export const MOTD_MAX_LENGTH = 2048;

export interface MotdStyle {
  /** Colour code (`0`–`f`), a smooth colour (`#rrggbb`) or null for the default (gray in the list). */
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

const HEX_COLOR = /^#[0-9a-f]{6}$/;
export const isHexColor = (color: string | null): color is string => !!color && HEX_COLOR.test(color);

/** The CSS colour of a code or smooth colour, or the fallback for the default. */
export const motdColorCss = (color: string | null, fallback = "#aaaaaa"): string => (isHexColor(color) ? color : (motdColor(color)?.hex ?? fallback));

/** The codes that write a colour: `§6` for a legacy colour, `§x§r§r§g§g§b§b` for a smooth one. */
const colorCodes = (color: string): string => (isHexColor(color) ? "§x" + [...color.slice(1)].map((d) => `§${d}`).join("") : `§${color}`);

/** The colour of the smooth colour code (`§x§r§r§g§g§b§b`) starting at `i`, or null if it isn't a complete one. */
function smoothAt(raw: string, i: number): string | null {
  if (raw[i + 1] !== "x" && raw[i + 1] !== "X") return null;
  let hex = "#";
  for (let k = 0; k < 6; k++) {
    const at = i + 2 + k * 2;
    if (raw[at] !== "§" || !/[0-9a-fA-F]/.test(raw[at + 1] ?? "")) return null;
    hex += raw[at + 1].toLowerCase();
  }
  return hex;
}

/** Length of the code that starts at `i` (a `§`): 14 for a complete smooth colour, otherwise 2, or 1 when dangling. */
const codeLength = (raw: string, i: number): number => (i + 1 >= raw.length ? 1 : smoothAt(raw, i) ? 14 : 2);

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
      const smooth = smoothAt(raw, i);
      if (smooth) {
        flush();
        style = { ...PLAIN, color: smooth };
        i += 13;
        continue;
      }
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
          out += colorCodes(seg.color!);
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
    if (raw[i] === "§") i += codeLength(raw, i);
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
      i += codeLength(raw, i);
      continue;
    }
    if (count === plain) return i;
    count++;
    i++;
  }
  return raw.length;
}

export interface MotdChange {
  /** Colour code (`0`–`f`) or smooth colour (`#rrggbb`) to give the text, keeping its styles. */
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
  const chars = motdChars(raw);
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
  return motdFromChars(chars);
}

interface StyledChar {
  ch: string;
  style: MotdStyle;
}

/** The text as one entry per character (the line break included), each with the style it is drawn in. */
function motdChars(raw: string): StyledChar[] {
  const chars: StyledChar[] = [];
  parseMotd(raw).forEach((segments, li) => {
    if (li > 0) chars.push({ ch: "\n", style: chars.length ? chars[chars.length - 1].style : { ...PLAIN } });
    for (const seg of segments) for (let k = 0; k < seg.text.length; k++) chars.push({ ch: seg.text[k], style: { ...seg, text: undefined } as MotdStyle });
  });
  return chars;
}

function motdFromChars(chars: StyledChar[]): string {
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

// ---- colour effects --------------------------------------------------------------------------------------------------

/** Colour stops of the ready-made effects. User artwork colours, not panel tokens. */
export const MOTD_EFFECTS = [
  { id: "rainbow", name: "Rainbow", stops: ["#ff3b30", "#ff9500", "#ffd60a", "#34c759", "#0a84ff", "#5e5ce6", "#bf5af2"] },
  { id: "sunset", name: "Sunset", stops: ["#ffd60a", "#ff7a18", "#ff2d55", "#8e2de2"] },
  { id: "ocean", name: "Ocean", stops: ["#7df9ff", "#1e90ff", "#1b2a8a"] },
  { id: "forest", name: "Forest", stops: ["#d4fc79", "#4ade80", "#0b6e3d"] },
  { id: "fire", name: "Fire", stops: ["#fff200", "#ff8a00", "#e52d27", "#6b0f1a"] },
  { id: "candy", name: "Candy", stops: ["#ff9ad5", "#c084fc", "#60a5fa"] },
  { id: "gold", name: "Gold", stops: ["#fff3b0", "#ffc300", "#b8860b"] },
  { id: "frost", name: "Frost", stops: ["#ffffff", "#a5f3fc", "#38bdf8"] },
] as const;

const channels = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** The legacy colour (`0`–`f`) closest to a colour, for servers that can't show smooth ones. */
export function nearestMotdColor(hex: string): string {
  const [r, g, b] = channels(hex);
  let best: string = MOTD_COLORS[0].code;
  let bestDistance = Infinity;
  for (const c of MOTD_COLORS) {
    const [cr, cg, cb] = channels(c.hex);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDistance) {
      best = c.code;
      bestDistance = d;
    }
  }
  return best;
}

/** `count` colours spread evenly over the stops, the first and last being the first and last stop. */
export function gradientColors(stops: readonly string[], count: number): string[] {
  if (count <= 0 || stops.length === 0) return [];
  if (stops.length === 1 || count === 1) return Array.from({ length: count }, () => stops[0]);
  return Array.from({ length: count }, (_, i) => {
    const at = (i / (count - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(at), stops.length - 2);
    const a = channels(stops[k]);
    const b = channels(stops[k + 1]);
    const t = at - k;
    return toHex(a.map((v, n) => v + (b[n] - v) * t));
  });
}

/**
 * Spread a colour effect over the visible characters `from`–`to`. Every letter gets its own colour; a space takes the
 * one before it (or after it, at the start), so it costs no code. Smooth colours (Paper, Purpur) are written as they
 * are; in classic mode each is replaced by the nearest of the sixteen legacy colours, which every server shows. Bold
 * and the other styles are kept.
 */
export function paintMotd(raw: string, from: number, to: number, stops: readonly string[], opts: { smooth: boolean }): string {
  const chars = motdChars(raw);
  const targets: StyledChar[] = [];
  for (let i = from; i < Math.min(to, chars.length); i++) if (chars[i].ch !== "\n") targets.push(chars[i]);
  // The halves of a surrogate pair (emoji) are one character, so the second half follows the first like a space does.
  const takesColor = (ch: string) => !/[\s\udc00-\udfff]/.test(ch);
  const letters = targets.filter((c) => takesColor(c.ch));
  const colors = gradientColors(stops, letters.length).map((hex) => (opts.smooth ? hex : nearestMotdColor(hex)));
  let n = 0;
  let previous = colors[0] ?? null;
  for (const c of targets) {
    if (takesColor(c.ch)) previous = colors[n++];
    if (previous) c.style = { ...c.style, color: previous };
  }
  return motdFromChars(chars);
}
