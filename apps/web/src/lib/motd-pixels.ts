/**
 * Pixel art for the message editor's symbol picker. Each symbol is a character the game's own font draws (that is what
 * lands in the message); the little picture only shows what it is, in the style of the game's items: a 9×9 grid with a
 * one pixel dark outline computed around the fill, two fills and a highlight. The pictures are user artwork, like the
 * icon generator's colours, so they don't come from the panel tokens.
 *
 * Letters: a main fill, b shade, h highlight, d detail, . empty.
 */

export const PIXEL_OUTLINE = "#1f1b16";

const PALETTES = {
  gold: { a: "#f5c542", b: "#c98a14", h: "#fff1a8", d: "#7a4a0a" },
  red: { a: "#e0403a", b: "#a31f1f", h: "#ff9c8f", d: "#6d1010" },
  silver: { a: "#dfe3e6", b: "#98a1a8", h: "#ffffff", d: "#4a4f55" },
  blue: { a: "#5aa0f0", b: "#2c5fb8", h: "#bfe0ff", d: "#173a78" },
  green: { a: "#5fcf4f", b: "#2f8a2a", h: "#b6f5a6", d: "#175c14" },
  purple: { a: "#a46be0", b: "#6a3fb0", h: "#dcc0ff", d: "#3d1f78" },
  stone: { a: "#a3a9ae", b: "#6b7075", h: "#d9dde0", d: "#2e3135" },
  pink: { a: "#f08fb4", b: "#c0547f", h: "#ffd0e2", d: "#f5c542" },
  ice: { a: "#9de8f2", b: "#55b6d6", h: "#ffffff", d: "#2c7fa6" },
  orange: { a: "#f08a2a", b: "#b8561a", h: "#ffd08a", d: "#6e3210" },
  sand: { a: "#f3e3a2", b: "#b98a45", h: "#fff7d6", d: "#7a5522" },
  steel: { a: "#d6dce2", b: "#7a8794", h: "#ffffff", d: "#8a5a2b" },
  shears: { a: "#d6dce2", b: "#7a8794", h: "#ffffff", d: "#d1403a" },
  coal: { a: "#4a4e55", b: "#2b2e33", h: "#8b9099", d: "#14161a" },
} as const;

export type PixelPalette = keyof typeof PALETTES;

export interface PixelSymbol {
  /** The character put into the message. */
  ch: string;
  name: string;
  palette: PixelPalette;
  rows: string[];
}

const flipX = (rows: string[]) => rows.map((r) => [...r].reverse().join(""));
const flipY = (rows: string[]) => [...rows].reverse();

const ARROW_RIGHT = [".....a...", "......a..", "aaaaaaaa.", "aaaaaaaaa", "aaaaaaaa.", "......a..", ".....a..."];
const ARROW_UP = ["....a....", "...aaa...", "..aaaaa..", ".aaaaaaa.", "...aaa...", "...aaa...", "...aaa..."];
const CHEVRONS = ["aa..aa...", ".aa..aa..", "..aa..aa.", "...aa..aa", "..aa..aa.", ".aa..aa..", "aa..aa..."];

export const MOTD_SYMBOL_GROUPS: { id: string; label: string; symbols: PixelSymbol[] }[] = [
  {
    id: "shine",
    label: "Stars & hearts",
    symbols: [
      { ch: "★", name: "Star", palette: "gold", rows: ["....a....", "...aha...", "...aaa...", "aaaaaaaaa", ".aaaaaaa.", "..aaaaa..", "..aabaa..", ".aab.baa.", ".ab...ba."] },
      { ch: "☆", name: "Outlined star", palette: "gold", rows: ["....a....", "...a.a...", "...a.a...", "aaaa.aaaa", ".a.....a.", "..a...a..", "..a.a.a..", ".a.....a.", ".aa...aa."] },
      { ch: "✦", name: "Sparkle", palette: "ice", rows: ["....a....", "....a....", "...aha...", "...aaa...", "aaahhhaaa", "...aaa...", "...aba...", "....b....", "....b...."] },
      { ch: "✧", name: "Outlined sparkle", palette: "purple", rows: ["....a....", "....a....", "...a.a...", "...a.a...", "aaa...aaa", "...a.a...", "...a.a...", "....a....", "....a...."] },
      { ch: "❤", name: "Heart", palette: "red", rows: [".aaa.aaa.", "ahhaaaaaa", "ahaaaaaab", "aaaaaaaab", ".aaaaaab.", "..aaaab..", "...aab...", "....b...."] },
      { ch: "♡", name: "Outlined heart", palette: "red", rows: [".aa...aa.", "a..a.a..a", "a...a...a", "a.......a", ".a.....a.", "..a...a..", "...a.a...", "....a...."] },
      { ch: "✿", name: "Flower", palette: "pink", rows: [".aa.a.aa.", "aaaaaaaaa", ".aaadaaa.", "aaadddaaa", ".aaadaaa.", "aaaaaaaaa", ".aa.a.aa."] },
      { ch: "☘", name: "Clover", palette: "green", rows: [".aa...aa.", "ahaa.aaaa", "aaaa.aaab", ".aaa.aaa.", "..aabaa..", ".aaa.aaa.", "aaaa.aaab", "aaaa.aaaa", ".aa...aa."] },
      { ch: "☀", name: "Sun", palette: "gold", rows: ["....b....", ".b..b..b.", "..aaaaa..", "..ahaaa..", "bbaaaaabb", "..aaaaa..", "..aaaaa..", ".b..b..b.", "....b...."] },
      { ch: "❄", name: "Snowflake", palette: "ice", rows: ["....a....", ".a..a..a.", "..a.a.a..", "...aaa...", "aaaaaaaaa", "...aaa...", "..a.a.a..", ".a..a..a.", "....a...."] },
      { ch: "⚡", name: "Lightning", palette: "gold", rows: [".....aaa.", "....aaa..", "...aaa...", "..aaaaaa.", ".....aa..", "....aa...", "...ab....", "...b....."] },
      { ch: "☽", name: "Moon", palette: "sand", rows: ["...aaaa..", "..aaa....", ".aaa.....", ".aaa.....", ".aaa.....", ".aaaa....", "..aaaab.b", "...bbbbb."] },
    ],
  },
  {
    id: "marks",
    label: "Arrows & marks",
    symbols: [
      { ch: "»", name: "Double arrow right", palette: "silver", rows: CHEVRONS },
      { ch: "«", name: "Double arrow left", palette: "silver", rows: flipX(CHEVRONS) },
      { ch: "→", name: "Arrow right", palette: "blue", rows: ARROW_RIGHT },
      { ch: "←", name: "Arrow left", palette: "blue", rows: flipX(ARROW_RIGHT) },
      { ch: "↑", name: "Arrow up", palette: "blue", rows: ARROW_UP },
      { ch: "↓", name: "Arrow down", palette: "blue", rows: flipY(ARROW_UP) },
      { ch: "➤", name: "Pointer", palette: "silver", rows: ["..a......", "..aaa....", "aaaaaaa..", "aaaaaaaaa", "aaaaaaa..", "..aaa....", "..a......"] },
      { ch: "✔", name: "Check mark", palette: "green", rows: ["........a", ".......aa", "......aaa", "a....aaa.", "aa..aaa..", "aaaaaa...", ".aaaa....", "..aa....."] },
      { ch: "✘", name: "Cross", palette: "red", rows: ["aa.....aa", "aaa...aaa", ".aaa.aaa.", "..aaaaa..", "...aaa...", "..aaaaa..", ".aaa.aaa.", "aaa...aaa", "aa.....aa"] },
      { ch: "✚", name: "Plus", palette: "red", rows: ["...aaa...", "...aaa...", "...aaa...", "aaaaaaaaa", "aaaaaaaaa", "aaaaaaaaa", "...aaa...", "...aaa...", "...aaa..."] },
      { ch: "⚠", name: "Warning", palette: "gold", rows: ["....a....", "...aaa...", "...ada...", "..aadaa..", "..aadaa..", ".aaaaaaa.", ".aaadaaa.", "aaaaaaaaa"] },
      { ch: "▶", name: "Play", palette: "green", rows: ["aa.......", "aaaa.....", "aaaaaa...", "aaaaaaaa.", "aaaaaa...", "aaaa.....", "aa......."] },
    ],
  },
  {
    id: "fun",
    label: "Game & fun",
    symbols: [
      { ch: "⚔", name: "Crossed swords", palette: "steel", rows: ["aa.....aa", "aaa...aaa", ".aaa.aaa.", "..aaaaa..", "...bbb...", "..b.d.b..", ".d..d..d.", "dd.....dd"] },
      { ch: "☠", name: "Skull", palette: "silver", rows: [".aaaaaaa.", "aaaaaaaaa", "aaddaddaa", "aaddaddaa", "aaaaddaaa", ".aaaaaaa.", ".adadada.", "..aaaaa.."] },
      { ch: "⚒", name: "Pickaxe", palette: "stone", rows: ["..aaaaaa.", ".aaaaaaaa", "aaa..b.aa", "aa..b...a", "...b.....", "..b......", ".b.......", "b........"] },
      { ch: "⚓", name: "Anchor", palette: "blue", rows: ["....a....", "...aaa...", "....a....", ".aaaaaaa.", "....a....", "a...a...a", "aa..a..aa", ".aaaaaaa.", "...aaa..."] },
      { ch: "⚑", name: "Flag", palette: "red", rows: ["baaaaaa..", "baaaaaaa.", "baaaaaa..", "baaaa....", "b........", "b........", "b........", "bb......."] },
      { ch: "⚙", name: "Gear", palette: "stone", rows: ["...aaa...", ".a.aaa.a.", ".aaaaaaa.", "aaaa.aaaa", "aaa...aaa", "aaaa.aaaa", ".aaaaaaa.", ".a.aaa.a.", "...aaa..."] },
      { ch: "✂", name: "Scissors", palette: "shears", rows: ["a.......a", ".a.....a.", "..a...a..", "...a.a...", "....a....", "...a.a...", "..dd.dd..", ".d..d..d.", "..dd.dd.."] },
      { ch: "♪", name: "Music note", palette: "purple", rows: ["...aaaaa.", "...aaaaa.", "...a...a.", "...a...a.", ".aaa.aaa.", "aaaa.aaaa", ".aa...aa."] },
      { ch: "✉", name: "Letter", palette: "silver", rows: ["aaaaaaaaa", "abbaaaabb", "aabbaabba", "aaabbbaaa", "aaaabaaaa", "aaaaaaaaa", "aaaaaaaaa"] },
      { ch: "⌛", name: "Hourglass", palette: "sand", rows: ["bbbbbbbbb", ".aaaaaaa.", "..aabaa..", "...aba...", "....b....", "...aba...", "..aabaa..", ".aaabaaa.", "bbbbbbbbb"] },
      { ch: "♠", name: "Spade", palette: "coal", rows: ["....a....", "...aaa...", "..aaaaa..", ".ahaaaaa.", "aahaaaaaa", "aaaaaaaaa", ".aa.a.aa.", "....a....", "...aaa..."] },
      { ch: "♦", name: "Diamond card", palette: "red", rows: ["....a....", "...aha...", "..ahaaa..", ".ahaaaaa.", "aaaaaaaaa", ".aaaaaab.", "..aaaab..", "...aab...", "....b...."] },
    ],
  },
  {
    id: "lines",
    label: "Shapes & lines",
    symbols: [
      { ch: "■", name: "Square", palette: "blue", rows: ["hhhhhhh", "haaaaab", "haaaaab", "haaaaab", "haaaaab", "haaaaab", "bbbbbbb"] },
      { ch: "□", name: "Outlined square", palette: "blue", rows: ["aaaaaaa", "a.....a", "a.....a", "a.....a", "a.....a", "a.....a", "aaaaaaa"] },
      { ch: "●", name: "Circle", palette: "green", rows: ["..aaaaa..", ".ahaaaaa.", "ahaaaaaaa", "aaaaaaaaa", "aaaaaaaaa", "aaaaaaaab", "aaaaaaabb", ".aaaabbb.", "..bbbbb.."] },
      { ch: "○", name: "Outlined circle", palette: "green", rows: ["..aaaaa..", ".aa...aa.", "aa.....aa", "a.......a", "a.......a", "a.......a", "aa.....aa", ".aa...aa.", "..aaaaa.."] },
      { ch: "◆", name: "Diamond", palette: "ice", rows: ["....a....", "...aha...", "..ahaaa..", ".ahaaaaa.", "aaaaaaaab", ".aaaaaab.", "..aaaab..", "...aab...", "....b...."] },
      { ch: "◇", name: "Outlined diamond", palette: "ice", rows: ["....a....", "...a.a...", "..a...a..", ".a.....a.", "a.......a", ".a.....a.", "..a...a..", "...a.a...", "....a...."] },
      { ch: "█", name: "Full block", palette: "stone", rows: ["hhhhhhhhh", "haaaaaaab", "haaaaaaab", "haaaaaaab", "haaaaaaab", "haaaaaaab", "haaaaaaab", "haaaaaaab", "bbbbbbbbb"] },
      { ch: "▓", name: "Dark shade", palette: "stone", rows: ["ababababa", "babababab", "ababababa", "babababab", "ababababa", "babababab", "ababababa"] },
      { ch: "░", name: "Light shade", palette: "stone", rows: ["hahahahah", "ahahahaha", "hahahahah", "ahahahaha", "hahahahah", "ahahahaha", "hahahahah"] },
      { ch: "═", name: "Double line", palette: "silver", rows: ["aaaaaaaaa", ".........", "aaaaaaaaa"] },
      { ch: "║", name: "Double bar", palette: "silver", rows: ["a.a", "a.a", "a.a", "a.a", "a.a", "a.a", "a.a", "a.a", "a.a"] },
      { ch: "•", name: "Bullet", palette: "gold", rows: ["hha", "aab"] },
    ],
  },
];

export interface PixelCell {
  x: number;
  y: number;
  color: string;
}

/** Side of the picture's square canvas: the 9×9 grid plus the outline around it. */
export const PIXEL_CANVAS = 11;

const cache = new Map<string, PixelCell[]>();

/** The symbol as coloured cells, centred in the canvas, with the outline added around every filled cell. */
export function pixelCells(symbol: PixelSymbol): PixelCell[] {
  const hit = cache.get(symbol.ch);
  if (hit) return hit;
  const palette: Record<string, string> = PALETTES[symbol.palette];
  const height = symbol.rows.length;
  const width = Math.max(...symbol.rows.map((r) => r.length));
  const ox = Math.floor((PIXEL_CANVAS - width) / 2);
  const oy = Math.floor((PIXEL_CANVAS - height) / 2);
  const fills = new Map<string, string>();
  symbol.rows.forEach((row, y) => [...row].forEach((c, x) => palette[c] && fills.set(`${x + ox},${y + oy}`, palette[c])));
  const cells: PixelCell[] = [];
  for (let y = 0; y < PIXEL_CANVAS; y++) {
    for (let x = 0; x < PIXEL_CANVAS; x++) {
      const fill = fills.get(`${x},${y}`);
      if (fill) cells.push({ x, y, color: fill });
      else if ([-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && fills.has(`${x + dx},${y + dy}`)))) cells.push({ x, y, color: PIXEL_OUTLINE });
    }
  }
  cache.set(symbol.ch, cells);
  return cells;
}
