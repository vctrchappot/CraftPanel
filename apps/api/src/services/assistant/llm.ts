import Anthropic from "@anthropic-ai/sdk";
import { AppError, ASSISTANT_PROVIDER_INFO, type AssistantSettings } from "@craftpanel/shared";

// One model call in a provider-neutral shape. The assistant keeps its history in these types and each provider
// translates it; Anthropic's own content blocks are kept as they came back, because thinking blocks must be
// sent back unchanged.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: { provider: "anthropic"; content: unknown[] }; reasoning?: string }
  | { role: "tool"; results: { id: string; content: string; isError: boolean }[] };

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: { provider: "anthropic"; content: unknown[] };
  /** Chat Completions reasoning (DeepSeek's reasoning_content), sent back while a tool loop runs. */
  reasoning?: string;
  /** "refusal": the model declined; "length": it ran out of output tokens. */
  stop: "end" | "tool" | "length" | "refusal";
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Receives the answer's text as it is written, for the live view. */
  onText?: (delta: string) => void;
}

export type ModelClient = (req: ModelRequest) => Promise<ModelReply>;

const TIMEOUT_MS = 90_000;

// Current Claude models accept a server-side fallback when their safety classifiers decline a request.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function createModelClient(settings: AssistantSettings, fetchImpl: typeof fetch = fetch): ModelClient {
  return settings.provider === "anthropic" ? anthropicClient(settings, fetchImpl) : chatCompletionsClient(settings, fetchImpl);
}

function anthropicClient(s: AssistantSettings, fetchImpl: typeof fetch): ModelClient {
  const client = new Anthropic({
    apiKey: s.apiKey,
    baseURL: s.baseUrl || undefined,
    fetch: fetchImpl,
    timeout: TIMEOUT_MS,
    maxRetries: 2,
  });
  const fallback = FALLBACK_MODELS.has(s.model) && !s.baseUrl;
  return async ({ system, messages, tools, signal, onText }) => {
    try {
      // Streamed, so the answer shows while it is written; the final message is the same as without streaming.
      const stream = client.beta.messages.stream(
        {
          model: s.model,
          max_tokens: 16000,
          system,
          messages: messages.map(toAnthropic) as Anthropic.Beta.BetaMessageParam[],
          ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool["input_schema"] })) } : {}),
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal },
      );
      if (onText) stream.on("text", (delta) => onText(delta));
      const res = await stream.finalMessage();
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      const toolCalls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
      const stop = res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "length" : toolCalls.length ? "tool" : "end";
      return { text, toolCalls, stop, raw: { provider: "anthropic", content: res.content } };
    } catch (err) {
      throw providerError(err instanceof Anthropic.APIError ? err.status : undefined, err);
    }
  };
}

function toAnthropic(m: ChatMessage): unknown {
  if (m.role === "user") return { role: "user", content: m.text };
  if (m.role === "tool")
    return { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError })) };
  if (m.raw?.provider === "anthropic") return { role: "assistant", content: m.raw.content };
  return {
    role: "assistant",
    content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))],
  };
}

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null; reasoning_content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  error?: { message?: string };
}

const chatBase = (s: AssistantSettings) => (s.baseUrl || ASSISTANT_PROVIDER_INFO[s.provider].defaultBaseUrl).replace(/\/+$/, "");
const chatHeaders = (s: AssistantSettings): Record<string, string> => ({
  ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}),
  // OpenRouter shows the app's name in its activity list.
  ...(s.provider === "openrouter" ? { "x-title": "CraftPanel" } : {}),
});

function chatCompletionsClient(s: AssistantSettings, fetchImpl: typeof fetch): ModelClient {
  const base = chatBase(s);
  return async ({ system, messages, tools, signal, onText }) => {
    // OpenAI and others reject an empty tools array, so it is left out (the connection test has none).
    const body = {
      model: s.model,
      messages: [{ role: "system", content: system }, ...messages.flatMap(toChatCompletions)],
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      stream: true,
    };
    // A streamed answer may take long overall; it fails only when the provider goes quiet for TIMEOUT_MS.
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(new DOMException("The AI provider stopped answering", "TimeoutError")), TIMEOUT_MS);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException("The AI provider stopped answering", "TimeoutError")), TIMEOUT_MS);
    };
    let res: Response;
    try {
      res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...chatHeaders(s) },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
      });
      if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) return await readChatStream(res, onText, alive);
    } catch (err) {
      throw err instanceof AppError ? err : providerError(undefined, err);
    } finally {
      clearTimeout(timer);
    }
    // Some servers answer with one JSON document even when asked to stream.
    const json = (await res.json().catch(() => ({}))) as ChatCompletion;
    if (!res.ok) throw providerError(res.status, new Error(json.error?.message ?? res.statusText));
    if (!json.choices) throw providerError(res.status, new Error("The answer is not a Chat Completions response. Check the base URL."));
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
    if (msg.refusal) return { text: msg.refusal, toolCalls: [], stop: "refusal" };
    const stop = choice?.finish_reason === "length" ? "length" : toolCalls.length ? "tool" : "end";
    return { text: (msg.content ?? "").trim(), toolCalls, stop, ...(msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}) };
  };
}

interface ChatChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  error?: { message?: string };
}

/** Reads a streamed Chat Completions answer (server-sent events), passing text on as it arrives. */
async function readChatStream(res: Response, onText: ((delta: string) => void) | undefined, alive: () => void): Promise<ModelReply> {
  let text = "";
  let reasoning = "";
  let refusal = "";
  let finish: string | null | undefined;
  // Tool calls arrive in pieces, keyed by index: the id and name first, the arguments spread over many chunks.
  const calls: { id: string; name: string; args: string }[] = [];
  const handle = (data: string) => {
    if (data === "[DONE]") return;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw providerError(500, new Error(chunk.error.message ?? "The AI provider reported an error"));
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (d.content) {
      text += d.content;
      onText?.(d.content);
    }
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (d.refusal) refusal += d.refusal;
    for (const tc of d.tool_calls ?? []) {
      const at = tc.index ?? calls.length;
      const call = (calls[at] ??= { id: "", name: "", args: "" });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name && !call.name) call.name = tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
    }
  };
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      alive();
      buffer += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handle(buffer.trim().slice(5).trim());
  } catch (err) {
    throw err instanceof AppError ? err : providerError(undefined, err);
  }
  if (refusal) return { text: refusal, toolCalls: [], stop: "refusal" };
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, input: parseArguments(c.args) }));
  const stop = finish === "length" ? "length" : toolCalls.length ? "tool" : "end";
  return { text: text.trim(), toolCalls, stop, ...(reasoning ? { reasoning } : {}) };
}

function toChatCompletions(m: ChatMessage): unknown[] {
  if (m.role === "user") return [{ role: "user", content: m.text }];
  if (m.role === "tool") return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content }));
  return [
    {
      role: "assistant",
      content: m.text || null,
      // DeepSeek's thinking mode needs its reasoning back while it still calls tools; other providers send none.
      ...(m.reasoning && m.toolCalls.length ? { reasoning_content: m.reasoning } : {}),
      ...(m.toolCalls.length
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
        : {}),
    },
  ];
}

// Model lists include embedding, speech and image models; those can't chat or call tools.
const NOT_CHAT = /(embed|tts|whisper|dall-e|moderation|transcri|realtime|audio|image|rerank|guard|aqa|imagen|veo)/i;

/** The models the provider offers with these settings, for the model picker. */
export async function listModels(s: AssistantSettings, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const signal = AbortSignal.timeout(20_000);
  if (s.provider === "anthropic") {
    const client = new Anthropic({ apiKey: s.apiKey, baseURL: s.baseUrl || undefined, fetch: fetchImpl, timeout: 20_000, maxRetries: 1 });
    try {
      const ids: string[] = [];
      for await (const m of client.models.list({ limit: 100 }, { signal })) ids.push(m.id);
      return ids;
    } catch (err) {
      throw providerError(err instanceof Anthropic.APIError ? err.status : undefined, err);
    }
  }
  let res: Response;
  try {
    res = await fetchImpl(`${chatBase(s)}/models`, { headers: chatHeaders(s), signal });
  } catch (err) {
    throw providerError(undefined, err);
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[]; error?: { message?: string } };
  if (!res.ok) throw providerError(res.status, new Error(json.error?.message ?? res.statusText));
  if (!Array.isArray(json.data)) throw providerError(res.status, new Error("The answer is not a model list. Check the base URL."));
  // Gemini lists "models/gemini-…"; its chat endpoint takes the bare name.
  const ids = json.data.flatMap((m) => (typeof m.id === "string" ? [m.id.replace(/^models\//, "")] : [])).filter((id) => !NOT_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Turns a provider failure into a message the dashboard can show, without echoing the key. */
function providerError(status: number | undefined, err: unknown): AppError {
  const detail = err instanceof Error ? err.message.slice(0, 300) : "";
  if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "APIUserAbortError") return new AppError(499, "assistant_cancelled", "Stopped");
  if (status === 401 || status === 403)
    return new AppError(502, "assistant_auth", "The AI provider rejected the API key", "Check the key in Settings → AI assistant.");
  if (status === 404)
    return new AppError(502, "assistant_model", "The AI provider does not know this model or endpoint", "Check the model name and the base URL in Settings → AI assistant.");
  if (status === 429)
    return new AppError(502, "assistant_rate_limited", "The AI provider is rate limiting requests or the account is out of credit", "Wait a moment, or check the plan and billing with the provider.");
  if (status === undefined)
    return new AppError(502, "assistant_unreachable", "Could not reach the AI provider", detail || "Check the base URL and this computer's internet connection.");
  return new AppError(502, "assistant_provider_error", `The AI provider answered with an error (${status})`, detail || undefined);
}
