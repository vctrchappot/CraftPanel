import type { WebSocket } from "ws";
import { canSeeServer, type Access, type WsServerMessage } from "@craftpanel/shared";

export interface HubClient {
  socket: WebSocket;
  userId: string;
  username: string;
  /** Access at connect time; changing a user's access closes their sockets so they reconnect. */
  access: Access;
  sessionId: string;
  subscriptions: Map<string, () => void>;
}

/** Fan-out of real-time events to connected dashboard clients. */
export class Hub {
  readonly clients = new Set<HubClient>();

  add(c: HubClient) {
    this.clients.add(c);
  }
  remove(c: HubClient) {
    for (const release of c.subscriptions.values()) release();
    c.subscriptions.clear();
    this.clients.delete(c);
  }

  send(c: HubClient, msg: WsServerMessage) {
    if (c.socket.readyState !== 1) return;
    // Back-pressure: drop for slow clients rather than buffering unbounded.
    if (c.socket.bufferedAmount > 8 * 1024 * 1024) return;
    c.socket.send(JSON.stringify(msg));
  }

  /** Send to everyone who may see the server concerned (status changes, activity, install progress). */
  broadcast(msg: WsServerMessage) {
    const data = JSON.stringify(msg);
    const serverId = serverOf(msg);
    for (const c of this.clients) {
      if (serverId !== undefined && !visible(c.access, serverId)) continue;
      if (c.socket.readyState === 1 && c.socket.bufferedAmount < 8 * 1024 * 1024) c.socket.send(data);
    }
  }

  /** Send only to clients subscribed to a server (console, metrics, players). */
  toSubscribers(serverId: string, msg: WsServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.subscriptions.has(serverId) && c.socket.readyState === 1 && c.socket.bufferedAmount < 8 * 1024 * 1024) c.socket.send(data);
  }

  /** Terminate all sockets belonging to a session (logout) or user (disabled). */
  disconnect(pred: (c: HubClient) => boolean, code = 4001) {
    for (const c of [...this.clients]) {
      if (pred(c)) {
        c.socket.close(code, code === 4001 ? "Session ended" : "Access changed");
        this.remove(c);
      }
    }
  }
}

/** The server a message is about: an id, null for application-wide events, undefined for neither. */
function serverOf(msg: WsServerMessage): string | null | undefined {
  if ("serverId" in msg) return msg.serverId;
  if (msg.type === "install") return msg.progress.serverId;
  if (msg.type === "event") return msg.event.serverId;
  return undefined;
}

function visible(access: Access, serverId: string | null) {
  if (serverId) return canSeeServer(access, serverId);
  // Application-wide activity (e.g. a deleted server) is for users who see every server.
  return access.serverScope === "all" || access.role === "owner";
}
