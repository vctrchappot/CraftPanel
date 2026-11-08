import net from "node:net";
import { describe, expect, it } from "vitest";
import { formatAddress, isCgnatIPv4, isPortAvailable, isPrivateIPv4, probeTcp, parseNetwork, ipMatches, isPrivateAddress, isPrivateNetwork, isClientAllowed } from "../src";

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

describe("dashboard access control", () => {
  it("classifies the entire CIDR range rather than just its first address", () => {
    for (const range of ["192.168.1.0/24", "10.0.0.0/8", "100.64.0.0/10", "fd00::/8", "::1"])
      expect(isPrivateNetwork(range), range).toBe(true);
    for (const range of ["192.168.1.1/0", "10.0.0.0/7", "100.64.0.0/9", "fd00::/6", "127.0.0.1/1", "203.0.113.1", "invalid"])
      expect(isPrivateNetwork(range), range).toBe(false);
  });
  it("parses and normalizes IPs and CIDR ranges", () => {
    expect(parseNetwork("192.168.1.0/24")).toBe("192.168.1.0/24");
    expect(parseNetwork(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(parseNetwork("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(parseNetwork("2001:db8::/32")).toBe("2001:db8::/32");
    for (const bad of ["", "10.0.0.0/33", "300.1.1.1", "2001:db8::/129", "10.0.0.0/8/1", "example.com", "1.2.3"]) expect(parseNetwork(bad)).toBeNull();
  });

  it("matches IPv4 and IPv6 ranges, including IPv4-mapped clients", () => {
    expect(ipMatches("::ffff:192.168.1.40", "192.168.1.0/24")).toBe(true);
    expect(ipMatches("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(ipMatches("2001:db8:1::5", "2001:db8::/32")).toBe(true);
    expect(ipMatches("2001:db9::5", "2001:db8::/32")).toBe(false);
    expect(ipMatches("203.0.113.7", "203.0.113.7")).toBe(true);
  });

  it("classifies private, VPN and public addresses", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.178.20", "100.101.102.103", "169.254.1.1", "fd7a:115c:a1e0::1", "fe80::1", "::1", "127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "203.0.113.7", "2001:4860::8888", "172.32.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("applies the policy, always allows the host itself and honours extra networks", () => {
    expect(isClientAllowed("127.0.0.1", "local")).toBe(true);
    expect(isClientAllowed("::1", "local")).toBe(true);
    expect(isClientAllowed("192.168.1.5", "local")).toBe(false);
    expect(isClientAllowed("192.168.1.5", "private")).toBe(true);
    expect(isClientAllowed("100.90.1.2", "private")).toBe(true); // Tailscale
    expect(isClientAllowed("203.0.113.7", "private")).toBe(false);
    expect(isClientAllowed("203.0.113.7", "private", ["203.0.113.0/24"])).toBe(true);
    expect(isClientAllowed("203.0.113.7", "any")).toBe(true);
  });
});
