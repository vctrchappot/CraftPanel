import crypto from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";
import type { ConsoleLine, ServerMetrics, ServerStatus } from "@craftpanel/shared";
import type { RuntimeAgent } from "./agent";

/** Increment for incompatible wire changes, independently of dashboard releases. */
export const RUNTIME_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const COMMAND_TTL_MS = 5000;
export type RuntimeInfo = ReturnType<RuntimeAgent["info"]>;
export interface RuntimeSnapshot {
  id: string;
  registered: boolean;
  status: ServerStatus;
  info: RuntimeInfo;
  alive: boolean;
  lines?: ConsoleLine[];
  metrics: ServerMetrics | null;
}

export function runtimePaths(dataDir: string) {
  const directory = path.join(path.resolve(dataDir), "runtime");
  const hash = crypto.createHash("sha256").update(process.platform === "win32" ? directory.toLowerCase() : directory).digest("hex").slice(0, 24);
  return {
    directory,
    token: path.join(directory, "token"),
    registry: path.join(directory, "servers.json"),
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\craftpanel-runtime-${hash}` : path.join(directory, "control.sock"),
  };
}

/** Newline-delimited JSON with bounded input AND output; slow peers reconnect. */
export function channel(socket: Socket, receive: (message: Record<string, unknown>) => void, failed: (reason: string, error?: unknown) => void = () => undefined) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const abort = (reason: string, error?: unknown) => { failed(reason, error); socket.destroy(); };
  socket.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const frame = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return abort("incoming-frame-too-large");
      let message: unknown;
      try {
        message = JSON.parse(frame);
      } catch { return abort("invalid-json-frame"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return abort("invalid-frame-object");
      try { receive(message as Record<string, unknown>); }
      catch (error) { return abort("frame-handler-failed", error); }
      if (socket.destroyed) return;
    }
    if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) abort("incoming-frame-too-large");
  });
  return (message: object): boolean => {
    if (socket.destroyed || !socket.writable) return false;
    const frame = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || socket.writableLength + Buffer.byteLength(frame) > 2 * MAX_FRAME_BYTES) {
      abort("outgoing-buffer-limit");
      return false;
    }
    return socket.write(frame);
  };
}

export function emptyRuntimeInfo(): RuntimeInfo {
  return { pid: null, startedAt: null, readyAt: null, players: [], lastError: null, lastExitCode: null, maxPlayers: null };
}
