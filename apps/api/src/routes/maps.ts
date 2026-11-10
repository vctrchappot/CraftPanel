import crypto from "node:crypto";
import http from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, canAccess, mapInstallSchema, mapSettingsSchema, notFound } from "@craftpanel/shared";
import { actorOf, noContent, requirePermission, type AppContext } from "../context";
import { SESSION_COOKIE } from "../auth/sessions";
import { checkPassword } from "../services/map";
import { parse } from "../validate";
import { isRequestOriginAllowed } from "../deployment";

type Id = { Params: { id: string } };
const TTL = 60 * 60_000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// BlueMap's marker sets access localStorage even with use-cookies=false. Give the
// opaque sandbox its own temporary Storage API, without granting dashboard-origin access.
const TEMPORARY_STORAGE = `<script>(()=>{for(const name of ["localStorage","sessionStorage"]){const data=new Map();const storage={get length(){return data.size},key(i){return [...data.keys()][i]??null},getItem(key){return data.get(String(key))??null},setItem(key,value){data.set(String(key),String(value))},removeItem(key){data.delete(String(key))},clear(){data.clear()}};Object.defineProperty(window,name,{value:storage,configurable:false,writable:false})}})();</script>`;

function page(reply: FastifyReply, content: string, status = 200) {
  return reply.code(status).type("text/html; charset=utf-8")
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'")
    .send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>World map · CraftPanel</title><style>body{margin:0;background:#111;color:#eee;font:15px system-ui}main{max-width:32rem;margin:10vh auto;padding:24px}a{color:inherit}input,button{font:inherit;padding:10px;margin-top:16px}iframe{position:fixed;border:0;width:100%;height:100%}p{line-height:1.6;color:#bbb}</style>${content}</html>`);
}

/** A GET-only, cookie-free proxy. No client-controlled host, port, headers or redirects reach upstream. */
export async function mapRoutes(app: FastifyInstance, ctx: AppContext) {
  const { maps, servers } = ctx;
  type Grant = { serverId: string; revision: string; expires: number; session?: string };
  const grants = new Map<string, Grant>();
  const grant = (serverId: string, revision: string, session?: string) => {
    for (const [key, g] of grants) if (g.expires < Date.now()) grants.delete(key);
    if (grants.size >= 2000) grants.delete(grants.keys().next().value!);
    const token = crypto.randomBytes(24).toString("base64url");
    grants.set(token, { serverId, revision, expires: Date.now() + TTL, session });
    return `/map/${serverId}/t/${token}/`;
  };

  app.get<Id>("/api/servers/:id/map", async (req) => {
    requirePermission(req, "server.view");
    return maps.status(await servers.row(req.params.id));
  });
  app.post<Id>("/api/servers/:id/map/install", async (req, reply) => {
    requirePermission(req, "map.manage");
    parse(mapInstallSchema, req.body);
    await maps.activate(await servers.row(req.params.id), actorOf(req));
    return reply.code(202).send({ ok: true });
  });
  app.put<Id>("/api/servers/:id/map", async (req) => {
    requirePermission(req, "map.manage");
    const input = parse(mapSettingsSchema, req.body);
    return servers.withLock(req.params.id, "map settings", async () => {
      const row = await servers.row(req.params.id);
      await maps.saveSettings(row, input, actorOf(req));
      return maps.status(row);
    });
  });
  app.post<Id>("/api/servers/:id/map/action", async (req, reply) => {
    requirePermission(req, "map.manage");
    const { action } = parse(z.object({ action: z.enum(["update", "pause", "resume", "rerender"]) }), req.body);
    await servers.withLock(req.params.id, "map action", async () => maps.act(await servers.row(req.params.id), action, actorOf(req)));
    return noContent(reply);
  });
  app.delete<Id & { Querystring: { deleteData?: string } }>("/api/servers/:id/map", async (req, reply) => {
    requirePermission(req, "map.manage");
    await servers.withLock(req.params.id, "map remove", async () => maps.remove(await servers.row(req.params.id), req.query.deleteData === "true", actorOf(req)));
    return noContent(reply);
  });
  app.post<Id>("/api/servers/:id/map/link", async (req) => {
    requirePermission(req, "server.view");
    const state = await maps.serving(req.params.id);
    if (!state) throw notFound("Map");
    return { url: grant(req.params.id, state.revision, req.cookies[SESSION_COOKIE]) };
  });

  // Separate scope keeps the form parser and higher tile-request allowance off API routes.
  await app.register(async (viewer) => {
    viewer.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    viewer.addHook("onRequest", async (_req, reply) => {
      reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer")
        .header("X-Frame-Options", "SAMEORIGIN").header("X-Robots-Tag", "noindex, nofollow");
    });
    viewer.post<Id>("/map/:id/unlock", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
      if (!isRequestOriginAllowed(req, ctx.config)) throw new AppError(403, "bad_origin", "Cross-origin request rejected");
      const state = await maps.serving(req.params.id);
      if (!state || state.settings.access !== "public" || !state.passwordHash) throw notFound("Map");
      const { password } = parse(z.object({ password: z.string().max(128) }), req.body);
      if (!checkPassword(password, state.passwordHash)) return page(reply, "<main><h1>Incorrect map password</h1><p>Go back and try again.</p></main>", 401);
      return reply.code(303).redirect(grant(req.params.id, state.revision));
    });
    const render = async (req: FastifyRequest<{ Params: { id: string; "*"?: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound("Map");
      const state = await maps.serving(id);
      if (!state) throw notFound("Map");
      const tail = req.params["*"] ?? "";
      const match = /^t\/([A-Za-z0-9_-]{1,64})\/(v\/(.*))?$/.exec(tail);
      let url: string;
      if (match) {
        const token = match[1]!;
        const g = grants.get(token);
        const publicAccess = token === "public" && state.settings.access === "public" && !state.passwordHash;
        let allowed = publicAccess || !!g && g.serverId === id && g.revision === state.revision && g.expires > Date.now();
        if (allowed && g?.session) {
          const user = await ctx.sessions.resolve(g.session);
          allowed = !!user && !user.twoFactorSetupRequired && canAccess(user, "server.view", id);
        }
        if (!allowed) return page(reply, `<main><h1>Map access expired</h1><p><a href="/map/${id}/">Open the map again</a></p></main>`, 401);
        url = `/map/${id}/t/${token}/`;
        if (match[2]) return proxyMap(req, reply, state, match[3] ?? "");
      } else {
        if (tail) throw notFound("Map");
        if (!req.url.split("?")[0]!.endsWith("/")) return reply.redirect(`/map/${id}/`);
        if (state.settings.access === "public" && !state.passwordHash) url = `/map/${id}/t/public/`;
        else {
          req.user = await ctx.sessions.resolve(req.cookies[SESSION_COOKIE], { ip: req.ip });
          if (req.user) {
            requirePermission(req, "server.view", id);
            url = grant(id, state.revision, req.cookies[SESSION_COOKIE]);
          } else if (state.settings.access === "public") {
            return page(reply, `<main><h1>World map</h1><p>Enter the password shared by the server administrator.</p><form method="post" action="/map/${id}/unlock"><label for="password">Map password</label><br><input id="password" name="password" type="password" required maxlength="128" autocomplete="current-password"><br><button>Open map</button></form></main>`);
          } else return page(reply, `<main><h1>Sign in to explore this world</h1><p><a href="/server/?id=${id}&amp;tab=map">Open CraftPanel</a></p></main>`, 401);
        }
      }
      return page(reply, `<iframe title="World map" src="${escapeHtml(url)}v/" sandbox="allow-scripts allow-pointer-lock" allow="fullscreen" referrerpolicy="no-referrer"></iframe>`);
    };
    const tiles = { logLevel: "warn" as const, config: { rateLimit: { max: 12000, timeWindow: "1 minute" } } };
    viewer.get<{ Params: { id: string } }>("/map/:id", tiles, render);
    viewer.get<{ Params: { id: string; "*": string } }>("/map/:id/*", tiles, render);
  });
}

async function proxyMap(req: FastifyRequest, reply: FastifyReply, state: { port: number; settings: { players: boolean }; allowedMaps: string[] }, asset: string) {
  reply.header("Access-Control-Allow-Origin", "*"); // Sandboxed fetches, including empty player responses, have an opaque origin.
  // Reject encoded and dot paths rather than relying on the upstream path normalizer.
  if (asset.length > 2048 || /[%\\\x00-\x20]/.test(asset) || asset.split("/").some((p) => p === "." || p === "..")) throw notFound("Map file");
  const map = /^maps\/([^/]+)\//.exec(asset)?.[1];
  if (map && !state.allowedMaps.includes(map)) throw notFound("Map");
  if (!state.settings.players && /\/players\.json$/.test(asset)) return reply.send({ players: [] });
  if (!(asset === "" || asset === "index.html" || asset === "settings.json" || /^assets\/[A-Za-z0-9_./-]+$/.test(asset) || /^lang\/[A-Za-z0-9_-]+\.conf$/.test(asset) || map)) throw notFound("Map file");
  // Sandbox also applies when someone opens the upstream HTML directly in a new tab.
  reply.header("Content-Security-Policy", "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src * blob: 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src * blob:; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: state.port, path: `/${asset}`, timeout: 10_000,
      headers: { "accept-encoding": ["", "index.html", "settings.json"].includes(asset) ? "identity" : String(req.headers["accept-encoding"] ?? "identity") } }, resolve);
    request.on("timeout", () => request.destroy(new Error("Map request timed out")));
    request.on("error", reject);
    reply.raw.on("close", () => request.destroy());
  }).catch(() => null);
  if (!upstream) return reply.code(503).type("text/plain").send("The map is not ready. Start the Minecraft server and wait for BlueMap to finish loading.");
  const status = upstream.statusCode ?? 502;
  if (status >= 300 && status < 400) { upstream.resume(); return reply.code(502).send("Map redirects are disabled"); }
  if ((asset === "" || asset === "index.html") && status === 200) {
    let html = "";
    for await (const chunk of upstream) {
      html += chunk.toString();
      if (html.length > 2 * 1024 * 1024) { upstream.destroy(); throw new AppError(502, "map_html", "Map viewer document is too large"); }
    }
    // This script must run before BlueMap's module initializes marker visibility.
    return reply.type("text/html; charset=utf-8").send(html.replace(/<head[^>]*>/i, (head) => head + TEMPORARY_STORAGE));
  }
  if (asset === "settings.json" && status === 200) {
    let body = "";
    for await (const chunk of upstream) {
      body += chunk.toString();
      if (body.length > 1024 * 1024) { upstream.destroy(); throw new AppError(502, "map_settings", "Map settings are too large"); }
    }
    const data = JSON.parse(body);
    data.maps = Array.isArray(data.maps) ? data.maps.filter((id: string) => state.allowedMaps.includes(id)) : [];
    data.mapDataRoot = "maps";
    data.liveDataRoot = "maps";
    data.useCookies = false;
    return reply.send(data);
  }
  for (const header of ["content-type", "content-encoding", "content-length"] as const) {
    if (upstream.headers[header]) reply.header(header, upstream.headers[header]);
  }
  return reply.code(status).send(upstream);
}
