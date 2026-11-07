import type { WebSocket } from "ws";
import type { Role, WsServerMessage } from "@craftpanel/shared";

export interface HubClient {
  socket: WebSocket;
  userId: string;
  username: string;
  role: Role;
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

  /** Send to everyone (status changes, activity, install progress). */
  broadcast(msg: WsServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.socket.readyState === 1 && c.socket.bufferedAmount < 8 * 1024 * 1024) c.socket.send(data);
  }

  /** Send only to clients subscribed to a server (console, metrics, players). */
  toSubscribers(serverId: string, msg: WsServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.subscriptions.has(serverId) && c.socket.readyState === 1 && c.socket.bufferedAmount < 8 * 1024 * 1024) c.socket.send(data);
  }

  /** Terminate all sockets belonging to a session (logout) or user (disabled). */
  disconnect(pred: (c: HubClient) => boolean) {
    for (const c of [...this.clients]) {
      if (pred(c)) {
        c.socket.close(4001, "Session ended");
        this.remove(c);
      }
    }
  }
}
