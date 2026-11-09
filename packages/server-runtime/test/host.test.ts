import { describe, expect, it } from "vitest";
import { cleanBoardName, detectHost, parseCgroupLimit } from "../src";

describe("host detection", () => {
  it("reads container memory limits and ignores 'unlimited'", () => {
    expect(parseCgroupLimit("2147483648\n")).toBe(2147483648);
    expect(parseCgroupLimit("max\n")).toBeNull();
    expect(parseCgroupLimit("9223372036854771712")).toBeNull();
    expect(parseCgroupLimit("0")).toBeNull();
    expect(parseCgroupLimit("")).toBeNull();
    expect(parseCgroupLimit(null)).toBeNull();
  });

  it("cleans board names", () => {
    expect(cleanBoardName("Raspberry Pi 4 Model B Rev 1.4\0")).toBe("Raspberry Pi 4 Model B Rev 1.4");
    expect(cleanBoardName("To Be Filled By O.E.M.")).toBeNull();
    expect(cleanBoardName("\0")).toBeNull();
    expect(cleanBoardName(undefined)).toBeNull();
  });

  it("describes this machine with sane values", () => {
    const h = detectHost();
    expect(h.cpus).toBeGreaterThanOrEqual(1);
    expect(h.memoryBytes).toBeGreaterThan(0);
    expect(h.memoryBytes).toBeLessThanOrEqual(h.physicalMemoryBytes);
    expect(h.memoryLimited).toBe(h.memoryBytes < h.physicalMemoryBytes);
  });
});
