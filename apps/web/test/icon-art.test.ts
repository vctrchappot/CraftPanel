import { describe, expect, it } from "vitest";
import { clampPan, DEFAULT_CROP, ICON_PX, initialsOf, placeImage } from "../src/lib/icon-art";

describe("placeImage", () => {
  it("fills the icon and crops the longer side of a wide picture", () => {
    const p = placeImage(200, 100, DEFAULT_CROP);
    expect(p.dh).toBeCloseTo(ICON_PX);
    expect(p.dw).toBeCloseTo(128);
    expect(p.dx).toBeCloseTo(-32);
    expect(p.dy).toBeCloseTo(0);
  });

  it("shows the whole picture centred when asked to", () => {
    const p = placeImage(200, 100, { ...DEFAULT_CROP, fit: "whole" });
    expect(p.dw).toBeCloseTo(ICON_PX);
    expect(p.dh).toBeCloseTo(32);
    expect(p.dy).toBeCloseTo(16);
  });

  it("zooms around the centre", () => {
    const p = placeImage(100, 100, { ...DEFAULT_CROP, zoom: 2 });
    expect(p.dw).toBeCloseTo(128);
    expect(p.dx).toBeCloseTo(-32);
  });

  it("keeps the picture from being dragged out of the icon", () => {
    const far = { ...DEFAULT_CROP, zoom: 2, panX: 500, panY: -500 };
    const p = placeImage(100, 100, far);
    expect(p.dx).toBeCloseTo(0);
    expect(p.dy).toBeCloseTo(-64);
    expect(clampPan(100, 100, far)).toEqual({ panX: 32, panY: -32 });
  });

  it("does not move a picture that exactly fits", () => {
    expect(clampPan(64, 64, { ...DEFAULT_CROP, panX: 10, panY: 10 })).toEqual({ panX: 0, panY: 0 });
  });
});

describe("initialsOf", () => {
  it("takes the first and last word's initial", () => {
    expect(initialsOf("Survival with friends")).toBe("SF");
    expect(initialsOf("Realm")).toBe("R");
    expect(initialsOf("  my-cool_server ")).toBe("MS");
    expect(initialsOf("—")).toBe("");
    expect(initialsOf("Ärger")).toBe("Ä");
  });
});
