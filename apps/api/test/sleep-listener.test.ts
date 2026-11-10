import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readVarInt, SleepListener, writeVarInt } from "../src/services/sleep-listener";

const open: SleepListener[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const str = (s: string) => Buffer.concat([writeVarInt(Buffer.byteLength(s)), Buffer.from(s)]);
const frame = (id: number, data = Buffer.alloc(0)) => {
  const body = Buffer.concat([writeVarInt(id), data]);
  return Buffer.concat([writeVarInt(body.length), body]);
};
const handshake = (next: number, protocol = 767) => frame(0, Buffer.concat([writeVarInt(protocol), str("localhost"), Buffer.from([0x63, 0xdd]), writeVarInt(next)]));

/** Send bytes, collect everything until the server closes the connection. */
function talk(port: number, ...chunks: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const got: Buffer[] = [];
    const sock = net.connect({ port, host: "127.0.0.1" }, async () => {
      for (const c of chunks) {
        sock.write(c);
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    sock.on("data", (d) => got.push(d));
    sock.on("close", () => resolve(Buffer.concat(got)));
    sock.on("error", reject);
    setTimeout(() => sock.destroy(), 3000).unref();
  });
}

/** The JSON of the first packet in a response. */
function firstJson(buf: Buffer): { id: number; json: Record<string, unknown> } {
  const len = readVarInt(buf) as { value: number; size: number };
  const id = readVarInt(buf, len.size) as { value: number; size: number };
  const strLen = readVarInt(buf, len.size + id.size) as { value: number; size: number };
  const start = len.size + id.size + strLen.size;
  return { id: id.value, json: JSON.parse(buf.subarray(start, start + strLen.value).toString("utf8")) };
}

async function listen(onWake: (remote: string) => void = () => undefined) {
  const port = await freePort();
  const l = await SleepListener.open({ port, host: "127.0.0.1", versionName: "Paper 1.21.4", maxPlayers: 12, favicon: "data:image/png;base64,AAAA", onWake });
  open.push(l);
  return port;
}

describe("sleeping server listener", () => {
  it("answers the server list ping with the sleeping notice and the client's protocol", async () => {
    const port = await listen();
    const res = await talk(port, handshake(1, 800), frame(0));
    const { id, json } = firstJson(res);
    expect(id).toBe(0);
    expect(json.version).toEqual({ name: "Paper 1.21.4", protocol: 800 });
    expect(json.players).toMatchObject({ max: 12, online: 0 });
    expect(json.favicon).toBe("data:image/png;base64,AAAA");
    expect(JSON.stringify(json.description)).toContain("wake the server up");
  });
  it("echoes the ping payload so the client can show its latency", async () => {
    const port = await listen();
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await talk(port, handshake(1), frame(0), frame(1, payload));
    const status = firstJson(res);
    const rest = res.subarray(res.length - 10);
    expect(status.id).toBe(0);
    expect(rest).toEqual(frame(1, payload));
  });
  it("tells a joining player that the server is waking up, and wakes it once the attempt is read", async () => {
    const woken: string[] = [];
    const port = await listen((remote) => woken.push(remote));
    expect(woken).toHaveLength(0);
    const res = await talk(port, handshake(2), frame(0, str("Steve")));
    const { id, json } = firstJson(res);
    expect(id).toBe(0);
    expect(String(json.text)).toMatch(/waking up/);
    expect(woken).toEqual(["127.0.0.1"]);
  });
  it("does not wake the server for a ping alone", async () => {
    const woken: string[] = [];
    const port = await listen((r) => woken.push(r));
    await talk(port, handshake(1), frame(0));
    expect(woken).toHaveLength(0);
  });
  it("drops garbage, oversized packets and the legacy ping without answering", async () => {
    const port = await listen();
    expect((await talk(port, Buffer.from([0xfe, 0x01, 0xfa]))).length).toBe(0);
    expect((await talk(port, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).length).toBe(0);
    expect((await talk(port, writeVarInt(100_000))).length).toBe(0);
    expect((await talk(port, handshake(9))).length).toBe(0);
    expect((await talk(port, frame(5, Buffer.from("nonsense")))).length).toBe(0);
  });
  it("handles a request split over several packets", async () => {
    const port = await listen();
    const all = Buffer.concat([handshake(1), frame(0)]);
    const res = await talk(port, all.subarray(0, 3), all.subarray(3, 9), all.subarray(9));
    expect(firstJson(res).json.version).toMatchObject({ name: "Paper 1.21.4" });
  });
  it("lets go of the port when closed", async () => {
    const port = await freePort();
    const l = await SleepListener.open({ port, host: "127.0.0.1", versionName: "x", maxPlayers: 1, favicon: null, onWake: () => undefined });
    await l.close();
    const l2 = await SleepListener.open({ port, host: "127.0.0.1", versionName: "x", maxPlayers: 1, favicon: null, onWake: () => undefined }, 1);
    open.push(l2);
  });
});
