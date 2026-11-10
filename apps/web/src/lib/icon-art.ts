/**
 * Drawing and geometry for the server icon editor. Minecraft wants a 64×64 PNG; the browser does the cropping and
 * drawing, so the API never has to decode a photo. The geometry is plain arithmetic and is tested without a canvas.
 */

export const ICON_PX = 64;

export interface CropState {
  /** 1 is the fitted size; larger zooms in. */
  zoom: number;
  /** Offset of the picture from the centre, in icon pixels. */
  panX: number;
  panY: number;
  /** "fill" covers the whole icon (the edges are cropped), "whole" shows the entire picture. */
  fit: "fill" | "whole";
  /** Off draws with hard pixel edges, which keeps pixel art sharp. */
  smooth: boolean;
  /** Colour behind a picture that doesn't fill the icon; null stays transparent. */
  background: string | null;
}

export const DEFAULT_CROP: CropState = { zoom: 1, panX: 0, panY: 0, fit: "fill", smooth: true, background: null };

export interface Placement {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));

/** Where the picture lands inside the 64×64 icon; the pan is kept so the picture can't be dragged away. */
export function placeImage(iw: number, ih: number, crop: CropState): Placement {
  const base = crop.fit === "fill" ? Math.max(ICON_PX / iw, ICON_PX / ih) : Math.min(ICON_PX / iw, ICON_PX / ih);
  const scale = base * crop.zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  const panX = clamp(crop.panX, Math.abs(dw - ICON_PX) / 2);
  const panY = clamp(crop.panY, Math.abs(dh - ICON_PX) / 2);
  return { dx: (ICON_PX - dw) / 2 + panX, dy: (ICON_PX - dh) / 2 + panY, dw, dh };
}

/** The pan after clamping, to store back into the state once a drag ends. */
export function clampPan(iw: number, ih: number, crop: CropState): { panX: number; panY: number } {
  const p = placeImage(iw, ih, crop);
  return { panX: p.dx - (ICON_PX - p.dw) / 2, panY: p.dy - (ICON_PX - p.dh) / 2 };
}

export function drawCrop(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, crop: CropState): void {
  ctx.clearRect(0, 0, ICON_PX, ICON_PX);
  if (crop.background) {
    ctx.fillStyle = crop.background;
    ctx.fillRect(0, 0, ICON_PX, ICON_PX);
  }
  ctx.imageSmoothingEnabled = crop.smooth;
  ctx.imageSmoothingQuality = "high";
  const p = placeImage(iw, ih, crop);
  ctx.drawImage(img, p.dx, p.dy, p.dw, p.dh);
}

// ---- generated icons ---------------------------------------------------------------------------------------------

export interface IconTheme {
  id: string;
  name: string;
  /** Light and dark end of the gradient, and the colour of the lettering. */
  from: string;
  to: string;
  ink: string;
}

/** Colours for the generator: user artwork, not interface colours, so they don't come from the panel tokens. */
export const ICON_THEMES: IconTheme[] = [
  { id: "signal", name: "Green", from: "#6fd05e", to: "#2f7a25", ink: "#0f2208" },
  { id: "amber", name: "Amber", from: "#f2c46a", to: "#b27a14", ink: "#2b1c00" },
  { id: "ember", name: "Red", from: "#f5766d", to: "#a8281d", ink: "#ffffff" },
  { id: "ocean", name: "Blue", from: "#6aa5ee", to: "#1f4f8f", ink: "#ffffff" },
  { id: "violet", name: "Violet", from: "#a487e6", to: "#4b3a8e", ink: "#ffffff" },
  { id: "rose", name: "Pink", from: "#ee83a2", to: "#8f2d50", ink: "#ffffff" },
  { id: "slate", name: "Slate", from: "#7b8591", to: "#2a3037", ink: "#ffffff" },
  { id: "sand", name: "Sand", from: "#e6d8b4", to: "#8f7e54", ink: "#2b2412" },
];

export type IconPattern = "none" | "stripes" | "dots" | "blocks";

export interface Generated {
  text: string;
  theme: string;
  pattern: IconPattern;
  rounded: boolean;
  fontFamily?: string;
}

/** One or two capital letters from a server name ("Survival with friends" → "SF", "Realm" → "R"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "";
  if (words.length === 0) return "";
  if (words.length === 1) return first(words[0]).toUpperCase();
  return (first(words[0]) + first(words[words.length - 1])).toUpperCase();
}

export function drawGenerated(ctx: CanvasRenderingContext2D, g: Generated): void {
  const theme = ICON_THEMES.find((t) => t.id === g.theme) ?? ICON_THEMES[0];
  const S = ICON_PX;
  ctx.clearRect(0, 0, S, S);
  ctx.save();
  if (g.rounded) {
    ctx.beginPath();
    ctx.roundRect(1, 1, S - 2, S - 2, 12);
    ctx.clip();
  }
  const gradient = ctx.createLinearGradient(0, 0, S, S);
  gradient.addColorStop(0, theme.from);
  gradient.addColorStop(1, theme.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  if (g.pattern === "stripes") {
    for (let x = -S; x < S * 2; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, S);
      ctx.lineTo(x + 6, S);
      ctx.lineTo(x + 6 + S, 0);
      ctx.lineTo(x + S, 0);
      ctx.fill();
    }
  } else if (g.pattern === "dots") {
    for (let y = 6; y < S; y += 12) for (let x = (y / 12) % 2 ? 12 : 6; x < S; x += 12) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  } else if (g.pattern === "blocks") {
    for (let y = 0; y < S; y += 8) for (let x = 0; x < S; x += 8) if (((x + y) / 8) % 2 === 0) ctx.fillRect(x, y, 8, 8);
  }
  ctx.restore();
  const text = Array.from(g.text).slice(0, 3).join("");
  if (text) {
    const size = text.length === 1 ? 42 : text.length === 2 ? 34 : 25;
    ctx.font = `700 ${size}px ${g.fontFamily ?? "system-ui, sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillText(text, S / 2, S / 2 + 3);
    ctx.fillStyle = theme.ink;
    ctx.fillText(text, S / 2, S / 2 + 1);
  }
}

/** The canvas as the base64 payload of a PNG (no `data:` prefix), as the API wants it. */
export function pngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
