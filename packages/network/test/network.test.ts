import net from "node:net";
import { describe, expect, it } from "vitest";
import { formatAddress, isCgnatIPv4, isPortAvailable, isPrivateIPv4, probeTcp } from "../src";

describe("network helpers", () => {
  it("classifies addresses", () => {
    expect(isPrivateIPv4("192.168.1.10")).toBe(true);
    expect(isPrivateIPv4("10.1.2.3")).toBe(true);
    expect(isPrivateIPv4("172.20.0.1")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isCgnatIPv4("100.64.0.1")).toBe(true);
    expect(isCgnatIPv4("100.128.0.1")).toBe(false);
  });
  it("formats Minecraft addresses (default port omitted)", () => {
    expect(formatAddress("192.168.1.10", 25565)).toBe("192.168.1.10");
    expect(formatAddress("192.168.1.10", 25570)).toBe("192.168.1.10:25570");
    expect(formatAddress("::1", 25570)).toBe("[::1]:25570");
  });
  it("detects port conflicts", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await isPortAvailable(port, "127.0.0.1")).toBe(false);
    expect(await probeTcp("127.0.0.1", port)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await isPortAvailable(port, "127.0.0.1")).toBe(true);
  });
});
