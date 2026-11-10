import { describe, expect, it } from "vitest";
import { MOTD_EFFECTS, MOTD_MAX_LENGTH, gradientColors, motdPlainLines, motdPlainOffset, motdProblem, motdRawIndex, nearestMotdColor, paintMotd, parseMotd, restyleMotd, serializeMotd, stripMotd } from "../src/motd";

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

const smooth = (hex: string) => "§x" + [...hex.slice(1)].map((d) => `§${d}`).join("");

describe("smooth colours", () => {
  it("reads and writes the §x§r§r§g§g§b§b form", () => {
    const raw = `${smooth("#ff8000")}Orange §bAqua ${smooth("#00ff7f")}§lGreen`;
    const [line] = parseMotd(raw);
    expect(line.map((s) => [s.text, s.color, s.bold])).toEqual([
      ["Orange ", "#ff8000", false],
      ["Aqua ", "b", false],
      ["Green", "#00ff7f", true],
    ]);
    expect(serializeMotd(parseMotd(raw))).toBe(raw);
  });

  it("drops an incomplete smooth colour like any unknown code", () => {
    expect(motdPlainLines("§x§f§fAB")[0]).toBe("AB");
    expect(stripMotd("§x§1§2§3Hi")).toBe("Hi");
  });

  it("counts a smooth colour as one code when mapping positions", () => {
    const raw = `${smooth("#123456")}ab§lc`;
    expect(motdPlainOffset(raw, 16)).toBe(2);
    expect(motdRawIndex(raw, 0)).toBe(14);
    expect(motdRawIndex(raw, 2)).toBe(18);
  });
});

describe("colour effects", () => {
  it("spreads colours evenly, from the first stop to the last", () => {
    expect(gradientColors(["#000000", "#ffffff"], 3)).toEqual(["#000000", "#808080", "#ffffff"]);
    expect(gradientColors(["#ff0000", "#00ff00", "#0000ff"], 5)).toEqual(["#ff0000", "#808000", "#00ff00", "#008080", "#0000ff"]);
    expect(gradientColors(["#123456"], 2)).toEqual(["#123456", "#123456"]);
    expect(gradientColors(["#123456"], 0)).toEqual([]);
  });

  it("finds the nearest legacy colour", () => {
    expect(nearestMotdColor("#ff5555")).toBe("c");
    expect(nearestMotdColor("#ff0000")).toBe("4");
    expect(nearestMotdColor("#101010")).toBe("0");
    expect(nearestMotdColor("#fefefe")).toBe("f");
  });

  it("paints a selection with smooth colours and keeps its styles", () => {
    const out = paintMotd("§lGo go", 0, 6, ["#ff0000", "#0000ff"], { smooth: true });
    const [line] = parseMotd(out);
    expect(line.map((s) => s.text).join("")).toBe("Go go");
    expect(line[0]).toMatchObject({ color: "#ff0000", bold: true });
    expect(line[line.length - 1]).toMatchObject({ color: "#0000ff", bold: true });
    expect(line.every((s) => s.bold)).toBe(true);
  });

  it("gives spaces the colour before them so they cost no code", () => {
    const out = paintMotd("ab cd", 0, 5, ["#ff0000", "#0000ff"], { smooth: true });
    const [line] = parseMotd(out);
    expect(line.map((s) => s.text)).toEqual(["a", "b ", "c", "d"]);
  });

  it("uses only the sixteen legacy colours in classic mode", () => {
    const out = paintMotd("Rainbow text here", 0, 17, [...MOTD_EFFECTS[0].stops], { smooth: false });
    expect(out).not.toContain("§x");
    for (const seg of parseMotd(out)[0]) expect(seg.color).toMatch(/^[0-9a-f]$/);
    expect(stripMotd(out)).toBe("Rainbow text here");
  });

  it("paints only the selection and works across both lines", () => {
    const out = paintMotd("one\ntwo", 2, 5, ["#00ff00"], { smooth: true });
    expect(parseMotd(out).map((l) => l.map((s) => [s.text, s.color]))).toEqual([[["on", null], ["e", "#00ff00"]], [["t", "#00ff00"], ["wo", null]]]);
  });

  it("recolours a selection with a smooth colour", () => {
    const out = restyleMotd("Hello", 0, 5, { color: "#336699" });
    expect(parseMotd(out)[0][0]).toMatchObject({ color: "#336699", text: "Hello" });
  });
});

describe("effects on emoji", () => {
  it("keeps both halves of a surrogate pair in one colour", () => {
    const out = paintMotd("a😀b", 0, 4, ["#ff0000", "#0000ff"], { smooth: true });
    const [line] = parseMotd(out);
    const emoji = line.find((s) => s.text.includes("😀"));
    expect(emoji?.text.startsWith("😀") || emoji?.text.includes("😀")).toBe(true);
    expect(stripMotd(out)).toBe("a😀b");
  });
});
