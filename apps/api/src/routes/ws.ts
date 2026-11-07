import type { FastifyInstance } from "fastify";
import { canAccess, commandSchema, type WsClientMessage } from "@craftpanel/shared";
import type { AppContext } from "../context";
import type { HubClient } from "../hub";

/**
 * Real-time channel. Authenticated by the session cookie during the upgrade;
 * the Origin header is checked to prevent cross-site WebSocket hijacking.
 */
export async function wsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const user = req.user;
    const origin = req.headers.origin;
    if (!user) {
      socket.close(4001, "Unauthenticated");
      return;
    }
    if (origin && !isAllowedOrigin(origin, req.headers.host, ctx.config.corsOrigins)) {
      socket.close(4003, "Origin not allowed");
      return;
    }
    if (user.twoFactorSetupRequired) {
      socket.close(4001, "Two-factor setup required");
      return;
    }
    const client: HubClient = { socket, userId: user.id, username: user.username, access: user, sessionId: user.sessionId, subscriptions: new Map() };
    ctx.hub.add(client);
    ctx.hub.send(client, { type: "hello", user: { id: user.id, username: user.username, role: user.role } });

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30000);
    socket.on("pong", () => (alive = true));

    socket.on("message", async (raw: Buffer) => {
      if (raw.length > 8192) return;
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "ping":
            return;
          case "subscribe": {
            if (typeof msg.serverId !== "string" || client.subscriptions.has(msg.serverId)) return;
            if (!canAccess(client.access, "console.read", msg.serverId)) return;
            await ctx.servers.row(msg.serverId);
            client.subscriptions.set(msg.serverId, ctx.agent.watch(msg.serverId));
            ctx.hub.send(client, { type: "console", serverId: msg.serverId, lines: ctx.agent.history(msg.serverId, 1000), replay: true });
            const metrics = ctx.agent.latestMetrics(msg.serverId);
            if (metrics) ctx.hub.send(client, { type: "metrics", serverId: msg.serverId, metrics });
            return;
          }
          case "unsubscribe": {
            client.subscriptions.get(msg.serverId)?.();
            client.subscriptions.delete(msg.serverId);
            return;
          }
          case "command": {
            if (!canAccess(client.access, "console.command", msg.serverId)) return ctx.hub.send(client, { type: "error", message: "You do not have permission to run commands" });
            const parsed = commandSchema.safeParse({ command: msg.command });
            if (!parsed.success) return ctx.hub.send(client, { type: "error", message: parsed.error.issues[0].message });
            ctx.servers.sendCommand(msg.serverId, parsed.data.command);
            await ctx.activity.audit({ id: client.userId, username: client.username, ip: req.ip }, "console.command", msg.serverId, { command: parsed.data.command });
            return;
          }
        }
      } catch (err) {
        ctx.hub.send(client, { type: "error", message: (err as Error).message });
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      ctx.hub.remove(client);
    });
  });
}

export function isAllowedOrigin(origin: string, host: string | undefined, extra: string[]): boolean {
  if (extra.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
