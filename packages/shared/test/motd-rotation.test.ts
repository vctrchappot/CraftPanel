import { describe, expect, it } from "vitest";
import { ROTATION_DEFAULT_INTERVAL, ROTATION_MAX_FRAMES, parseRotation, rotationProblem, serializeRotation } from "../src/motd-rotation";

describe("rotation file", () => {
  it("round-trips messages with line breaks, backslashes and symbols", () => {
    const rotation = { interval: 10, frames: ["§6§lWelcome\n§7to the server ✦", "a\\b\n\\n literally", "§x§f§f§8§0§0§0Hex\n"] };
    const text = serializeRotation(rotation);
    expect(text.split("\n").filter((l) => l.startsWith("frame="))).toHaveLength(3);
    expect(parseRotation(text)).toEqual(rotation);
  });

  it("keeps each message on one line so the plugin can read it line by line", () => {
    const text = serializeRotation({ interval: 5, frames: ["one\ntwo"] });
    expect(text).toContain("frame=one\\ntwo\n");
    expect(text.startsWith("#")).toBe(true);
  });

  it("reads a file with comments, Windows line endings and a missing or broken interval", () => {
    expect(parseRotation("# note\r\ninterval=3\r\nframe=a\r\nframe=b\\nc\r\n")).toEqual({ interval: 3, frames: ["a", "b\nc"] });
    expect(parseRotation("frame=a").interval).toBe(ROTATION_DEFAULT_INTERVAL);
    expect(parseRotation("interval=soon\nframe=a").interval).toBe(ROTATION_DEFAULT_INTERVAL);
    expect(parseRotation("")).toEqual({ interval: ROTATION_DEFAULT_INTERVAL, frames: [] });
  });
});

describe("rotationProblem", () => {
  it("accepts up to the maximum of two-line messages", () => {
    expect(rotationProblem({ interval: 5, frames: [] })).toBeNull();
    expect(rotationProblem({ interval: 5, frames: Array.from({ length: ROTATION_MAX_FRAMES }, (_, i) => `§a${i}\n§bline`) })).toBeNull();
  });

  it("names the message that is wrong", () => {
    expect(rotationProblem({ interval: 5, frames: Array.from({ length: ROTATION_MAX_FRAMES + 1 }, () => "x") })).toMatch(/At most/);
    expect(rotationProblem({ interval: 5, frames: ["ok", "§6§l "] })).toBe("Message 2 is empty.");
    expect(rotationProblem({ interval: 5, frames: ["a\nb\nc"] })).toMatch(/^Message 1: .*two lines/);
  });
});
