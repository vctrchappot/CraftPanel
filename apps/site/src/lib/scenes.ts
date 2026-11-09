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
  led: ["#5bbf4a", "#439b35", "#327b28"] as Shades,
  ledRed: ["#ef5a4f", "#c3463c", "#98362e"] as Shades,
  case: ["#3b3935", "#2b2926", "#22201e"] as Shades,
  caseLight: ["#55524d", "#403d39", "#34322e"] as Shades,
  bezel: ["#1b1a18", "#141311", "#100f0e"] as Shades,
  smoke: ["#d9d6d0", "#b9b5ae", "#a29e97"] as Shades,
  shirt: ["#3fa7a4", "#2f8582", "#266c6a"] as Shades,
  pants: ["#4a54a8", "#3a4288", "#2f366f"] as Shades,
  skin: ["#d8a982", "#b98a66", "#9f7556"] as Shades,
};

// Motion hooks: a box's class names are picked up by landing.css. Classes only describe what moves
// (a floating island, smoke, a walking player); the scene stays complete and still without CSS.
const tag = (boxes: Box[], cls: string): Box[] => boxes.map((b) => ({ ...b, class: b.class ? `${cls} ${b.class}` : cls }));

/** Three puffs rising from a chimney top at (x, y, z), staggered by the n-th chimney. */
function smoke(x: number, y: number, z: number, n = 0): Box[] {
  return [0, 1, 2].map((i) => box(x, y, z, 0.2, 0.2, 0.2, C.smoke, `smoke smoke-${i} chimney-${n}`));
}

/** A blocky player (legs, shirt, head) standing at (x, y, z), looking along the path. */
function player(x: number, y: number, z: number, cls: string): Box[] {
  return tag([box(x, y, z, 0.24, 0.18, 0.4, C.pants), box(x, y, z + 0.4, 0.24, 0.18, 0.38, C.shirt), box(x - 0.01, y - 0.02, z + 0.78, 0.26, 0.22, 0.26, C.skin)], cls);
}

const box = (x: number, y: number, z: number, w: number, d: number, h: number, c: Shades, cls?: string): Box => ({ x, y, z, w, d, h, c, class: cls });

/** Back-to-front order for unit blocks: lower x+y first, then lower z. */
const byDepth = (a: Box, b: Box) => a.x + a.y - (b.x + b.y) || a.z - b.z;

function grassBlock(x: number, y: number, z: number): Box[] {
  return [box(x, y, z, 1, 1, 0.78, C.dirt), box(x, y, z + 0.78, 1, 1, 0.22, C.grass)];
}

function piBoard(ox: number, oy: number): Box[] {
  const parts: Box[] = [box(ox, oy, 0, 6, 4, 0.22, C.pcb)];
  // Copper tracks, mounting pads and tiny surface-mount parts make this a board, not a green slab.
  const trace: Shades = ["#438557", "#327043", "#285b36"];
  for (let i = 0; i < 5; i++) {
    parts.push(box(ox + 0.8, oy + 0.8 + i * 0.21, 0.225, 3.7, 0.025, 0.01, trace));
    parts.push(box(ox + 3.8 + i * 0.12, oy + 0.9, 0.225, 0.025, 2.3, 0.01, trace));
  }
  for (const [x, y] of [[0.25, 0.25], [0.25, 3.5], [4.55, 0.25], [4.55, 3.5]]) {
    parts.push(box(ox + x, oy + y, 0.22, 0.22, 0.22, 0.03, C.gold));
    parts.push(box(ox + x + 0.055, oy + y + 0.055, 0.255, 0.11, 0.11, 0.01, C.chip));
  }
  // GPIO header along the back edge
  for (let i = 0; i < 16; i++) parts.push(box(ox + 0.5 + i * 0.3, oy + 0.18, 0.22, 0.16, 0.34, 0.32, C.chip));
  parts.push(box(ox + 1.2, oy + 1.25, 0.22, 1.5, 1.5, 0.2, C.silver)); // SoC heat spreader
  parts.push(box(ox + 3.2, oy + 1.4, 0.22, 0.9, 1.2, 0.14, C.chip)); // RAM
  for (let i = 0; i < 5; i++) parts.push(box(ox + 1.15 + i * 0.48, oy + 2.95, 0.22, 0.23, 0.15, 0.11, C.silver));
  parts.push(box(ox + 0.35, oy + 3.2, 0.22, 0.28, 0.28, 0.14, C.led, "led led-act")); // activity LED
  parts.push(box(ox + 0.8, oy + 3.2, 0.22, 0.28, 0.28, 0.14, C.ledRed));
  // USB and Ethernet ports overhanging the right edge
  parts.push(box(ox + 5.0, oy + 0.35, 0.22, 1.25, 0.95, 0.72, C.silver));
  parts.push(box(ox + 5.0, oy + 1.5, 0.22, 1.25, 0.95, 0.72, C.silver));
  parts.push(box(ox + 5.0, oy + 2.65, 0.22, 1.25, 1.1, 0.82, C.silver));
  // Dark sockets on the exposed end faces.
  for (const y of [0.48, 1.63]) {
    parts.push(box(ox + 6.25, oy + y, 0.38, 0.015, 0.68, 0.14, C.bezel));
    parts.push(box(ox + 6.25, oy + y, 0.64, 0.015, 0.68, 0.14, C.bezel));
  }
  parts.push(box(ox + 6.25, oy + 2.82, 0.38, 0.015, 0.75, 0.49, C.bezel));
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
    "GGGS",
    "GGWG",
  ];
  layout.forEach((row, j) =>
    [...row].forEach((k, i) => {
      const x = 1 + i;
      const y = 0.4 + j;
      if (k === "G") world.push(...grassBlock(x, y, z));
      if (k === "S") world.push(box(x, y, z, 1, 1, 0.92, C.sand));
      if (k === "W") world.push(box(x, y, z, 1, 1, 0.78, C.water, "water"));
    }),
  );
  // dirt under the island, so it reads as a chunk of world
  const under: Box[] = [box(1.5, 0.9, z - 0.8, 2, 2, 0.8, C.dirt), box(2, 1.4, z - 1.3, 1, 1, 0.5, C.stone)];
  // A tree, a tiny shelter and a footpath give the world a sense of being lived in.
  const tree: Box[] = [
    box(1.35, 0.75, z + 1, 0.3, 0.3, 1.1, C.log),
    box(0.9, 0.3, z + 2.1, 1.2, 1.2, 0.8, C.leaves),
    box(1.2, 0.6, z + 2.9, 0.6, 0.6, 0.4, C.leaves),
  ];
  const details: Box[] = [
    ...cottage(2.7, 0.65, z + 1, 0.65),
    box(2.45, 1.85, z + 1.01, 0.42, 1.25, 0.025, C.sand),
    box(1.25, 2.65, z + 1, 0.12, 0.12, 0.22, C.leaves),
    box(1.22, 2.62, z + 1.22, 0.18, 0.18, 0.1, C.gold),
    box(3.6, 2.5, z + 1, 0.12, 0.12, 0.18, C.leaves),
    box(3.57, 2.47, z + 1.18, 0.18, 0.18, 0.1, C.ledRed),
  ];
  // Data between the SoC and the world it runs: small packets rise from the heat spreader.
  const packets = [0, 1, 2].map((i) => box(1.75 + i * 0.25, 1.8 - i * 0.2, 0.5, 0.16, 0.16, 0.16, C.led, `packet packet-${i}`));
  // The cottage (scale 0.65) has its chimney top at x 2.78–2.96, y 0.88–1.08, z + 2.63.
  const island = tag([...under, ...world.sort(byDepth), ...tree, ...details], "float");
  return [...piBoard(0, 0), ...packets, ...island, ...tag(smoke(2.77, 0.88, z + 2.63), "float")];
}

/** Original voxel shelter: stepped slate roof, timber walls and one warm window. */
function cottage(x: number, y: number, z: number, scale = 1): Box[] {
  const b = (dx: number, dy: number, dz: number, w: number, d: number, h: number, c: Shades) =>
    box(x + dx * scale, y + dy * scale, z + dz * scale, w * scale, d * scale, h * scale, c);
  return [
    b(0, 0, 0, 1.5, 1.7, 1.3, C.log),
    b(0.52, 1.7, 0, 0.48, 0.02, 0.95, C.bezel),
    { ...b(1.5, 0.4, 0.52, 0.02, 0.55, 0.5, C.gold), class: "window" },
    b(-0.18, -0.15, 1.3, 1.86, 2, 0.18, C.caseLight),
    b(-0.02, -0.15, 1.48, 1.54, 2, 0.18, C.case),
    b(0.16, -0.15, 1.66, 1.18, 2, 0.18, C.caseLight),
    b(0.34, -0.15, 1.84, 0.82, 2, 0.18, C.case),
    b(0.52, -0.15, 2.02, 0.46, 2, 0.18, C.caseLight),
    b(0.12, 0.35, 1.85, 0.28, 0.3, 0.65, C.stone),
  ];
}

/** Three worlds on one physical host. The separate runtime keeps them alive during panel restarts. */
export function runtimeScene(): Box[] {
  const parts = [box(-0.3, -0.3, -0.45, 8.6, 5.6, 0.45, C.case)];
  const terrain: Box[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 8; x++) {
    terrain.push(...grassBlock(x, y, 0));
  }
  // Paths meet across the shared host; these are Minecraft worlds, not isolation containers.
  const pathParts: Box[] = [];
  for (let x = 0; x < 8; x++) pathParts.push(box(x, 3.2, 1.01, 1, 0.42, 0.025, C.sand));
  // Each window gets its own index so the three homes don't flicker in step.
  const homes = [0.6, 3.1, 5.6].flatMap((x, n) => cottage(x, 0.5, 1).map((b) => (b.class === "window" ? { ...b, class: `window window-${n}` } : b)));
  // Chimney tops (x + 0.12–0.4, y 0.85–1.15, z 3.5): smoke keeps rising during panel updates.
  const chimneys = [0.6, 3.1, 5.6].flatMap((x, n) => smoke(x + 0.16, 0.9, 3.5, n));
  // Players walking along the shared path, in both directions: the worlds keep ticking.
  const walkers = [...player(0.2, 3.3, 1.03, "walker walker-0"), ...player(6.9, 3.42, 1.03, "walker walker-1")];
  const sockets = Array.from({ length: 9 }, (_, i) => box(0.4 + i * 0.8, 5.3, -0.32, 0.42, 0.02, 0.15, C.bezel));
  const light = box(7.55, 5.3, -0.3, 0.18, 0.02, 0.18, C.led, "led");
  return [...parts, ...terrain.sort(byDepth), ...pathParts, ...homes, ...walkers, ...chimneys, ...sockets, light];
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
  parts.push(box(1.45, 4, 2.0, 0.18, 0.08, 0.18, C.gold, "led-act"));
  for (let i = 0; i < 4; i++) parts.push(box(0.3, 4, 0.3 + i * 0.32, 1.6, 0.04, 0.12, C.bezel));
  // side window glow on +x side
  parts.push(box(2.2, 0.5, 0.8, 0.04, 3, 3.2, ["#3a5f2a", "#2c4a20", "#3d6a2b"]));
  // Side-panel framing and two quiet cooling fans, rather than an undifferentiated green window.
  for (const y of [0.85, 2.15]) {
    parts.push(box(2.25, y, 1.6, 0.025, 0.9, 0.9, C.bezel));
    parts.push(box(2.28, y + 0.15, 1.75, 0.025, 0.6, 0.6, C.caseLight));
    parts.push(box(2.3, y + 0.33, 1.93, 0.025, 0.24, 0.24, C.silver));
  }
  parts.push(box(0.25, 0.35, -0.15, 0.4, 0.45, 0.15, C.bezel));
  parts.push(box(1.65, 3.15, -0.15, 0.4, 0.45, 0.15, C.bezel));
  // a little grass block sitting on top, for scale and charm
  parts.push(...grassBlock(0.6, 1.4, 4.6));
  return parts;
}

export function vpsScene(): Box[] {
  const parts: Box[] = [];
  for (let u = 0; u < 3; u++) {
    const z = u * 0.95;
    parts.push(box(0, 0, z, 6, 3.6, 0.85, u === 1 ? C.caseLight : C.case));
    parts.push(box(0.4, 3.6, z + 0.25, 0.22, 0.05, 0.22, u === 1 ? C.led : C.gold, u === 1 ? "led" : `led-act unit-${u}`));
    for (let i = 0; i < 6; i++) parts.push(box(1.2 + i * 0.7, 3.6, z + 0.2, 0.5, 0.04, 0.42, C.bezel));
  }
  // Rack ears and screws keep the cloud machine as physical as the PC and Pi.
  for (const x of [-0.25, 5.95]) {
    parts.push(box(x, 3.62, 0.05, 0.3, 0.09, 2.65, C.caseLight));
    for (const z of [0.3, 1.25, 2.2]) parts.push(box(x + 0.1, 3.72, z, 0.1, 0.02, 0.1, C.silver));
  }
  return parts;
}
