import type { FastifyInstance } from "fastify";
import { assistantDecisionSchema, assistantMessageSchema, assistantSettingsSchema, badRequest, type AssistantSettings } from "@craftpanel/shared";
import { SESSION_COOKIE } from "../auth/sessions";
import { actorOf, noContent, requirePermission, requireUser, type AppContext } from "../context";
import { REDACTED } from "../services/settings";
import { parse } from "../validate";

type IdParams = { Params: { id: string } };

/** The optional AI assistant: owner settings, and conversations that act with the asking user's permissions. */
export async function assistantRoutes(app: FastifyInstance, ctx: AppContext) {
  const { assistant } = ctx;

  app.get("/api/assistant", async (req) => assistant.status(requireUser(req)));

  // ---- settings (owner) -------------------------------------------------------------------

  /** The submitted settings, with the redacted placeholder replaced by the stored key. */
  const incoming = async (body: unknown): Promise<AssistantSettings> => {
    const s = parse(assistantSettingsSchema, body);
    if (s.apiKey === REDACTED) s.apiKey = (await assistant.config()).apiKey;
    return s;
  };

  app.get("/api/assistant/settings", async (req) => {
    requirePermission(req, "app.configure");
    return (await ctx.settings.publicView()).assistant;
  });
  app.put("/api/assistant/settings", async (req) => {
    requirePermission(req, "app.configure");
    const s = await incoming(req.body);
    if (s.enabled && !s.model) throw badRequest("Choose a model", "Enter the model name your provider uses, for example claude-opus-5-5.");
    if (s.enabled && s.provider === "openai-compatible" && !s.baseUrl) throw badRequest("Enter the base URL of the API", "For example https://openrouter.ai/api/v1 or http://localhost:11434/v1 for Ollama.");
    await ctx.settings.set({ assistant: s });
    const { apiKey: _key, instructions: _text, ...logged } = s;
    await ctx.activity.audit(actorOf(req), "settings.assistant", null, { ...logged, apiKey: s.apiKey ? "set" : "none" });
    return (await ctx.settings.publicView()).assistant;
  });
  app.post("/api/assistant/settings/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    requirePermission(req, "app.configure");
    return assistant.test(await incoming(req.body));
  });

  // ---- conversations -------------------------------------------------------------------------

  app.get("/api/assistant/conversations", async (req) => assistant.list(requireUser(req)));
  app.post("/api/assistant/conversations", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(assistantMessageSchema, req.body);
    return assistant.send(user, req.cookies[SESSION_COOKIE] ?? "", req.ip, body);
  });
  app.get<IdParams>("/api/assistant/conversations/:id", async (req) => assistant.get(requireUser(req), req.params.id));
  app.post<IdParams>("/api/assistant/conversations/:id/decision", async (req) => {
    const body = parse(assistantDecisionSchema, req.body);
    return assistant.decide(requireUser(req), req.params.id, body.toolCallId, body.approve);
  });
  app.post<IdParams>("/api/assistant/conversations/:id/cancel", async (req) => assistant.cancel(requireUser(req), req.params.id));
  app.delete<IdParams>("/api/assistant/conversations/:id", async (req, reply) => {
    assistant.remove(requireUser(req), req.params.id);
    return noContent(reply);
  });
}
