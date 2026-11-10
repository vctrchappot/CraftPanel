import net from "node:net";

/**
 * What stands on a sleeping server's port. It answers the server list ping, so the server shows up as "asleep"
 * instead of "offline", and the first player who tries to join gets a "waking up" message while `onWake` starts the
 * real server. It speaks just enough of the Java Edition protocol for that (handshake, status, login) and nothing
 * else: no packet is trusted beyond a few kilobytes, idle connections are cut after a few seconds.
 */

const MAX_PACKET = 4096;
const MAX_CONNECTIONS = 32;
const IDLE_MS = 5000;

export interface SleepListenerOptions {
  port: number;
  host: string;
  /** Software and version shown in the server list, e.g. "Paper 1.21.4". */
  versionName: string;
  maxPlayers: number;
  /** A `data:image/png;base64,…` URL of the server icon. */
  favicon: string | null;
  /** Called with the remote address when someone tries to join. */
  onWake: (remote: string) => void;
}

export const SLEEP_STATUS_TEXT = [
  { text: "Asleep. ", color: "yellow" },
  { text: "Join to wake the server up, it takes about a minute.", color: "gray" },
];
export const SLEEP_LOGIN_TEXT = { text: "The server was asleep and is waking up. Join again in about a minute.", color: "yellow" };

export function writeVarInt(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

/** The value and its length in bytes; null while the bytes are incomplete, -1 for something that is not a VarInt. */
export function readVarInt(buf: Buffer, offset = 0): { value: number; size: number } | null | -1 {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i]!;
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  return -1;
}

function packet(id: number, data: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), data]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function text(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}

type Phase = "handshake" | "status" | "login" | "done";

export class SleepListener {
  private connections = new Set<net.Socket>();
  private constructor(
    private server: net.Server,
    private opts: SleepListenerOptions,
  ) {
    server.on("connection", (socket) => this.accept(socket));
  }

  /** Bind the port; retries briefly because a server that just stopped may still hold it for a moment. */
  static async open(opts: SleepListenerOptions, attempts = 10): Promise<SleepListener> {
    for (let i = 1; ; i++) {
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ port: opts.port, host: opts.host, exclusive: true }, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", () => undefined);
        return new SleepListener(server, opts);
      } catch (err) {
        server.close();
        if (i >= attempts || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async close(): Promise<void> {
    for (const s of this.connections) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private statusJson(protocol: number): string {
    return JSON.stringify({
      version: { name: this.opts.versionName, protocol },
      players: { max: this.opts.maxPlayers, online: 0, sample: [] },
      description: { text: "", extra: SLEEP_STATUS_TEXT },
      ...(this.opts.favicon ? { favicon: this.opts.favicon } : {}),
    });
  }

  private accept(socket: net.Socket) {
    if (this.connections.size >= MAX_CONNECTIONS) return void socket.destroy();
    this.connections.add(socket);
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => socket.destroy());
    let buf = Buffer.alloc(0);
    let phase: Phase = "handshake";
    let protocol = 0;
    const remote = socket.remoteAddress ?? "unknown";
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (phase === "done") return;
        if (buf[0] === 0xfe) return void socket.destroy(); // pre-1.7 ping, not worth answering
        const len = readVarInt(buf);
        if (len === null) return;
        if (len === -1 || len.value < 1 || len.value > MAX_PACKET) return void socket.destroy();
        if (buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const id = readVarInt(body);
        if (id === null || id === -1) return void socket.destroy();
        const data = body.subarray(id.size);
        if (phase === "handshake") {
          const proto = readVarInt(data);
          if (id.value !== 0 || proto === null || proto === -1) return void socket.destroy();
          const hostLen = readVarInt(data, proto.size);
          if (hostLen === null || hostLen === -1) return void socket.destroy();
          const next = readVarInt(data, proto.size + hostLen.size + hostLen.value + 2);
          if (next === null || next === -1) return void socket.destroy();
          protocol = proto.value;
          phase = next.value === 1 ? "status" : next.value === 2 || next.value === 3 ? "login" : "done";
          if (phase === "done") return void socket.destroy();
        } else if (phase === "status") {
          if (id.value === 0) socket.write(packet(0, text(this.statusJson(protocol))));
          else if (id.value === 1 && data.length === 8) {
            socket.end(packet(1, data));
            phase = "done";
          } else return void socket.destroy();
        } else {
          // Login Start: whoever it is, tell them to come back and start the real server.
          socket.end(packet(0, text(JSON.stringify(SLEEP_LOGIN_TEXT))));
          phase = "done";
          this.opts.onWake(remote);
        }
      }
    });
  }
}
