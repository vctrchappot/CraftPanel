import { describe, expect, it } from "vitest";
import { timeAgo, formatDateTime } from "../src/lib/format";
import { eventStyle } from "../src/lib/activity";
import { connectEntries } from "../src/lib/network";

describe("dashboard presentation", () => {
  it("formats relative times in the English UI locale regardless of the host locale", () => {
    const now = Date.UTC(2026, 10, 9, 12);
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(timeAgo(now - 86400_000, now)).toBe("yesterday");
    expect(timeAgo(now + 2 * 3600_000, now)).toBe("in 2 hours");
    expect(timeAgo(null, now)).toBe("never");
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(formatDateTime(now)).toContain("Nov");
  });

  it("uses lifecycle colours and distinct icons while keeping updates neutral", () => {
    expect(eventStyle({ kind: "server.running", level: "info" })).toEqual({ tone: "running", icon: "online" });
    expect(eventStyle({ kind: "server.start", level: "info" }).tone).toBe("starting");
    expect(eventStyle({ kind: "server.stopped", level: "info" }).tone).toBe("stopped");
    expect(eventStyle({ kind: "server.crashed", level: "error" }).tone).toBe("crashed");
    expect(eventStyle({ kind: "server.installed", level: "info" })).toEqual({ tone: "neutral", icon: "install" });
    expect(eventStyle({ kind: "craftpanel.updated", level: "info" })).toEqual({ tone: "neutral", icon: "update" });
    expect(eventStyle({ kind: "backup.failed", level: "error" }).tone).toBe("crashed");
    expect(eventStyle({ kind: "other", level: "warn" }).tone).toBe("warning");
  });

  it("keeps adapter labels from new APIs and supports the previous address response", () => {
    const network = [{ address: "172.20.0.1", kind: "virtual" as const, label: "Virtual adapter (WSL)" }];
    expect(connectEntries({ local: "localhost", lan: ["172.20.0.1"], network })).toEqual(network);
    expect(connectEntries({ local: "localhost", lan: ["192.168.1.4"] })).toEqual([
      { address: "192.168.1.4", kind: "lan", label: "Local network" },
    ]);
  });
});
