import { describe, expect, it } from "vitest";
import { MOTD_MAX_LENGTH, motdPlainLines, motdPlainOffset, motdProblem, motdRawIndex, parseMotd, restyleMotd, serializeMotd, stripMotd } from "../src/motd";

describe("parseMotd", () => {
  it("reads colours and formats into styled segments", () => {
    const [line] = parseMotd("§6§lGold §rplain §bAqua");
    expect(line.map((s) => [s.text, s.color, s.bold])).toEqual([
      ["Gold ", "6", true],
      ["plain ", null, false],
      ["Aqua", "b", false],
    ]);
  });

  it("lets a colour code clear the formats before it", () => {
    const [line] = parseMotd("§l§nBoth§cRed");
    expect(line[0]).toMatchObject({ bold: true, underline: true, color: null });
    expect(line[1]).toMatchObject({ color: "c", bold: false, underline: false });
  });

  it("keeps a style across the line break and drops unknown or dangling codes", () => {
    const lines = parseMotd("§aLine one\nstill green §zhidden§");
    expect(lines).toHaveLength(2);
    expect(lines[1][0]).toMatchObject({ text: "still green hidden", color: "a" });
  });

  it("is case-insensitive about codes", () => {
    expect(parseMotd("§AX")[0][0]).toMatchObject({ color: "a", text: "X" });
  });
});

describe("serializeMotd", () => {
  const samples = ["§6§lWelcome §rto §ahome", "plain", "§aone\n§btwo", "§l§oBold italic §nand underline§r then plain", "§cRed §lbold red §eyellow", "", "\n"];

  it("round-trips to the same styled text", () => {
    for (const s of samples) expect(parseMotd(serializeMotd(parseMotd(s)))).toEqual(parseMotd(s));
  });

  it("only resets when a format has to be dropped", () => {
    expect(serializeMotd(parseMotd("§6A§bB"))).toBe("§6A§bB");
    expect(serializeMotd(parseMotd("§lA§rB"))).toBe("§lA§rB");
  });
});

describe("helpers", () => {
  it("strips codes line by line", () => {
    expect(motdPlainLines("§6§lHi\n§rthere")).toEqual(["Hi", "there"]);
    expect(stripMotd("§aA\n§bB")).toBe("A\nB");
  });

  it("reports too many lines and too many characters", () => {
    expect(motdProblem("a\nb")).toBeNull();
    expect(motdProblem("a\nb\nc")).toMatch(/two lines/);
    expect(motdProblem("x".repeat(MOTD_MAX_LENGTH + 1))).toMatch(/Too long/);
  });
});

describe("restyleMotd", () => {
  it("colours a selection and returns to the default after it", () => {
    expect(restyleMotd("Hello world", 0, 5, { color: "6" })).toBe("§6Hello§r world");
  });

  it("toggles a format on and off again without losing the colour", () => {
    const gold = restyleMotd("Hello world", 0, 11, { color: "6" });
    const bold = restyleMotd(gold, 0, 11, { toggle: "bold" });
    expect(bold).toBe("§6§lHello world");
    expect(parseMotd(bold)[0][0]).toMatchObject({ color: "6", bold: true });
    expect(restyleMotd(bold, 0, 11, { toggle: "bold" })).toBe("§6Hello world");
  });

  it("does not let a colour wipe out a style that was chosen first", () => {
    const bold = restyleMotd("Hello", 0, 5, { toggle: "bold" });
    expect(parseMotd(restyleMotd(bold, 0, 5, { color: "a" }))[0][0]).toMatchObject({ color: "a", bold: true });
  });

  it("clears the styles of a selection and tidies leftover codes", () => {
    expect(restyleMotd("§6§lHello §rworld", 0, 11, { clear: true })).toBe("Hello world");
    expect(restyleMotd("§6§lHello §rworld", 0, 5, { clear: true })).toBe("Hello§6§l §rworld");
    expect(restyleMotd("§6Hello§r§r", 0, 5, { toggle: "italic" })).toBe("§6§oHello");
  });

  it("works across the line break and maps positions between raw and visible text", () => {
    const next = restyleMotd("one\ntwo", 2, 5, { color: "c" });
    expect(parseMotd(next).map((l) => l.map((s) => [s.text, s.color]))).toEqual([[["on", null], ["e", "c"]], [["t", "c"], ["wo", null]]]);
    expect(motdPlainOffset("§6ab§lc", 5)).toBe(2);
    expect(motdRawIndex("§6ab§lc", 2)).toBe(6);
    expect(motdRawIndex("§6ab§lc", 0)).toBe(2);
  });
});
