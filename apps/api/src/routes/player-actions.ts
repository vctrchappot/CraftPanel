import type { FastifyInstance } from "fastify";
import { playerNameSchema } from "@craftpanel/shared";
import { actorOf, requirePermission, type AppContext } from "../context";
import { parse } from "../validate";

type PlayerParams = { Params: { id: string; name: string } };

/** What operators can do to a player beyond the profile: look inside their data, and act on them while they are online. */
export async function playerActionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { servers, game } = ctx;

  app.get<PlayerParams>("/api/servers/:id/players/:name/inspect", async (req) => {
    requirePermission(req, "server.view");
    return game.inspectPlayer(await servers.row(req.params.id), parse(playerNameSchema, req.params.name));
  });

  app.post<PlayerParams & { Params: { action: string }; Body: { params?: unknown } }>("/api/servers/:id/players/:name/actions/:action", async (req) => {
    requirePermission(req, "players.manage");
    const name = parse(playerNameSchema, req.params.name);
    const body = (req.body ?? {}) as { params?: unknown };
    const summary = await game.playerDo(await servers.row(req.params.id), name, req.params.action, body.params ?? {}, actorOf(req));
    return { summary };
  });
}
