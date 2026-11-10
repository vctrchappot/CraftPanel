import { describe, expect, it } from "vitest";
import { MOTD_SYMBOL_GROUPS, PIXEL_CANVAS, PIXEL_OUTLINE, pixelCells } from "../src/lib/motd-pixels";

const all = MOTD_SYMBOL_GROUPS.flatMap((g) => g.symbols);

describe("symbol pictures", () => {
  it("offers each character once, as one character the game's font can draw", () => {
    expect(new Set(all.map((s) => s.ch)).size).toBe(all.length);
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
    for (const s of all) {
      expect(s.ch.length, s.name).toBe(1);
      expect(s.ch.charCodeAt(0), s.name).toBeGreaterThan(0x7f);
      expect(s.ch, s.name).not.toBe("§");
    }
  });

  it("draws every symbol on at most 9×9 pixels from the known letters", () => {
    for (const s of all) {
      expect(s.rows.length, s.name).toBeLessThanOrEqual(9);
      for (const row of s.rows) {
        expect(row.length, s.name).toBeLessThanOrEqual(9);
        expect(row, s.name).toMatch(/^[.abhd]+$/);
      }
    }
  });

  it("fits the outlined picture inside the canvas and wraps every fill in an outline", () => {
    for (const s of all) {
      const cells = pixelCells(s);
      expect(cells.length, s.name).toBeGreaterThan(0);
      for (const c of cells) {
        expect(c.x, s.name).toBeGreaterThanOrEqual(0);
        expect(c.x, s.name).toBeLessThan(PIXEL_CANVAS);
        expect(c.y, s.name).toBeGreaterThanOrEqual(0);
        expect(c.y, s.name).toBeLessThan(PIXEL_CANVAS);
      }
      const at = new Map(cells.map((c) => [`${c.x},${c.y}`, c.color]));
      const outer = cells.filter((c) => c.color === PIXEL_OUTLINE);
      expect(outer.length, s.name).toBeGreaterThan(0);
      // Every neighbour of a fill inside the canvas is drawn too: more fill or the outline.
      for (const c of cells.filter((c) => c.color !== PIXEL_OUTLINE)) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = `${c.x + dx},${c.y + dy}`;
          if (c.x + dx >= 0 && c.y + dy >= 0 && c.x + dx < PIXEL_CANVAS && c.y + dy < PIXEL_CANVAS) expect(at.has(n), `${s.name} leaves ${n} open`).toBe(true);
        }
      }
    }
  });
});
