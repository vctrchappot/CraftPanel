// Isometric scenes for the landing page: a Raspberry Pi with a little world running on it, a desktop PC and a VPS rack.
import type { Box } from "../components/Iso.astro";

type Shades = [string, string, string];
const C = {
  pcb: ["#2f7347", "#205133", "#193f28"] as Shades,
  chip: ["#2c2b2e", "#1d1c1f", "#161518"] as Shades,
  silver: ["#d3d6db", "#a7acb3", "#8a9098"] as Shades,
  gold: ["#e0b04a", "#b88a2c", "#9a7322"] as Shades,
  grass: ["#86c13a", "#5f9a2b", "#4c7f22"] as Shades,
  dirt: ["#8d5b3d", "#6f4630", "#59382a"] as Shades,
  stone: ["#8a8580", "#6c6762", "#5a5651"] as Shades,
  leaves: ["#3f8f3a", "#2f6f2c", "#255a24"] as Shades,
  log: ["#7a5532", "#5f4127", "#4b331f"] as Shades,
  water: ["#4a8de0", "#3569b0", "#2b558f"] as Shades,
  sand: ["#e3d39b", "#c7b67c", "#ad9d67"] as Shades,
  led: ["#5ce08d", "#3fb56c", "#349458"] as Shades,
  ledRed: ["#ff6a55", "#d9493a", "#b53a2e"] as Shades,
  case: ["#3b3935", "#2b2926", "#22201e"] as Shades,
  caseLight: ["#55524d", "#403d39", "#34322e"] as Shades,
  bezel: ["#1b1a18", "#141311", "#100f0e"] as Shades,
};

const box = (x: number, y: number, z: number, w: number, d: number, h: number, c: Shades, cls?: string): Box => ({ x, y, z, w, d, h, c, class: cls });

/** Back-to-front order for unit blocks: lower x+y first, then lower z. */
const byDepth = (a: Box, b: Box) => a.x + a.y - (b.x + b.y) || a.z - b.z;

function grassBlock(x: number, y: number, z: number): Box[] {
  return [box(x, y, z, 1, 1, 0.78, C.dirt), box(x, y, z + 0.78, 1, 1, 0.22, C.grass)];
}

function piBoard(ox: number, oy: number): Box[] {
  const parts: Box[] = [box(ox, oy, 0, 6, 4, 0.22, C.pcb)];
  // GPIO header along the back edge
  for (let i = 0; i < 16; i++) parts.push(box(ox + 0.5 + i * 0.3, oy + 0.18, 0.22, 0.16, 0.34, 0.32, C.chip));
  parts.push(box(ox + 1.2, oy + 1.25, 0.22, 1.5, 1.5, 0.2, C.silver)); // SoC heat spreader
  parts.push(box(ox + 3.2, oy + 1.4, 0.22, 0.9, 1.2, 0.14, C.chip)); // RAM
  parts.push(box(ox + 0.35, oy + 3.2, 0.22, 0.28, 0.28, 0.14, C.led, "led")); // power LED
  parts.push(box(ox + 0.8, oy + 3.2, 0.22, 0.28, 0.28, 0.14, C.ledRed));
  // USB and Ethernet ports overhanging the right edge
  parts.push(box(ox + 5.0, oy + 0.35, 0.22, 1.25, 0.95, 0.72, C.silver));
  parts.push(box(ox + 5.0, oy + 1.5, 0.22, 1.25, 0.95, 0.72, C.silver));
  parts.push(box(ox + 5.0, oy + 2.65, 0.22, 1.25, 1.1, 0.82, C.silver));
  // micro HDMI / USB-C on the front edge
  parts.push(box(ox + 1.6, oy + 3.75, 0.22, 0.7, 0.4, 0.26, C.silver));
  parts.push(box(ox + 2.8, oy + 3.75, 0.22, 0.6, 0.4, 0.26, C.silver));
  return parts;
}

/** The hero scene: a Pi with a small floating world above it. */
export function heroScene(): Box[] {
  const z = 3.6;
  const world: Box[] = [];
  const layout = [
    "GGGS",
    "GGWS",
    "GGGG",
  ];
  layout.forEach((row, j) =>
    [...row].forEach((k, i) => {
      const x = 1 + i;
      const y = 0.4 + j;
      if (k === "G") world.push(...grassBlock(x, y, z));
      if (k === "S") world.push(box(x, y, z, 1, 1, 0.92, C.sand));
      if (k === "W") world.push(box(x, y, z, 1, 1, 0.78, C.water));
    }),
  );
  // dirt under the island, so it reads as a chunk of world
  const under: Box[] = [box(1.5, 0.9, z - 0.8, 2, 2, 0.8, C.dirt), box(2, 1.4, z - 1.3, 1, 1, 0.5, C.stone)];
  // a tree on the back-left block and a stone block
  const tree: Box[] = [
    box(1.35, 0.75, z + 1, 0.3, 0.3, 1.1, C.log),
    box(0.9, 0.3, z + 2.1, 1.2, 1.2, 0.8, C.leaves),
    box(1.2, 0.6, z + 2.9, 0.6, 0.6, 0.4, C.leaves),
  ];
  const extra: Box[] = [box(2, 2.4, z + 1, 1, 1, 1, C.stone)];
  const island = [...world, ...extra].sort(byDepth);
  return [...piBoard(0, 0), ...under, ...island, ...tree];
}

export function piScene(): Box[] {
  return piBoard(0, 0);
}

export function pcScene(): Box[] {
  const parts: Box[] = [box(0, 0, 0, 2.2, 4, 4.6, C.case)];
  // front panel faces +y: bays, power button, vents
  parts.push(box(0.3, 4, 3.6, 1.6, 0.06, 0.55, C.bezel));
  parts.push(box(0.3, 4, 2.9, 1.6, 0.06, 0.5, C.bezel));
  parts.push(box(0.9, 4, 1.9, 0.4, 0.08, 0.4, C.led, "led"));
  for (let i = 0; i < 4; i++) parts.push(box(0.3, 4, 0.3 + i * 0.32, 1.6, 0.04, 0.12, C.bezel));
  // side window glow on +x side
  parts.push(box(2.2, 0.5, 0.8, 0.04, 3, 3.2, ["#3a5f2a", "#2c4a20", "#3d6a2b"]));
  // a little grass block sitting on top, for scale and charm
  parts.push(...grassBlock(0.6, 1.4, 4.6));
  return parts;
}

export function vpsScene(): Box[] {
  const parts: Box[] = [];
  for (let u = 0; u < 3; u++) {
    const z = u * 0.95;
    parts.push(box(0, 0, z, 6, 3.6, 0.85, u === 1 ? C.caseLight : C.case));
    parts.push(box(0.4, 3.6, z + 0.25, 0.22, 0.05, 0.22, u === 1 ? C.led : C.gold, u === 1 ? "led" : undefined));
    for (let i = 0; i < 6; i++) parts.push(box(1.2 + i * 0.7, 3.6, z + 0.2, 0.5, 0.04, 0.42, C.bezel));
  }
  return parts;
}
