import { z } from "zod";
import { ROLES, type Role } from "./roles";

// The optional AI assistant: the owner brings an API key for a model provider, and users ask in plain language.
// The assistant acts through tools with the asking user's own permissions; changes wait for approval.

/** "openai-compatible" covers any Chat Completions API: OpenRouter, Mistral, Groq, Gemini's OpenAI endpoint, Ollama, LM Studio. */
export const ASSISTANT_PROVIDERS = ["anthropic", "openai", "openai-compatible"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const ASSISTANT_PROVIDER_INFO: Record<AssistantProvider, { label: string; defaultModel: string; defaultBaseUrl: string; keyRequired: boolean }> = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-opus-5-5", defaultBaseUrl: "https://api.anthropic.com", keyRequired: true },
  openai: { label: "OpenAI", defaultModel: "", defaultBaseUrl: "https://api.openai.com/v1", keyRequired: true },
  "openai-compatible": { label: "OpenAI-compatible API", defaultModel: "", defaultBaseUrl: "", keyRequired: false },
};

/** Base URLs offered for the OpenAI-compatible provider; any other URL works too. */
export const ASSISTANT_ENDPOINT_PRESETS = [
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { label: "Ollama (this computer)", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio (this computer)", baseUrl: "http://localhost:1234/v1" },
] as const;

/** Tool groups the owner can switch on or off. Each tool still checks the user's permission. */
export const ASSISTANT_TOOL_GROUPS = ["servers", "console", "players", "plugins", "backups", "schedules", "settings", "files"] as const;
export type AssistantToolGroup = (typeof ASSISTANT_TOOL_GROUPS)[number];

export const ASSISTANT_TOOL_GROUP_INFO: Record<AssistantToolGroup, { label: string; description: string }> = {
  servers: { label: "Servers", description: "Status, performance, start, stop and restart" },
  console: { label: "Console", description: "Read the console and send commands" },
  players: { label: "Players", description: "Online players, whitelist, operators, kicks and bans" },
  plugins: { label: "Plugins and mods", description: "List installed add-ons, search and install from Modrinth" },
  backups: { label: "Backups", description: "List backups and create new ones" },
  schedules: { label: "Automation", description: "List and create scheduled tasks" },
  settings: { label: "Server settings", description: "Read and change server.properties" },
  files: { label: "Files", description: "List, read and write text files in a server folder" },
};

/**
 * "always": every change waits for the user's approval. "risky": routine changes (start, restart, a backup,
 * adding someone to the whitelist) run at once; anything that can lose data, lock people out or run code still asks.
 */
export const ASSISTANT_APPROVAL_MODES = ["always", "risky"] as const;
export type AssistantApprovalMode = (typeof ASSISTANT_APPROVAL_MODES)[number];

export interface AssistantSettings {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  /** "" = the provider's default endpoint. */
  baseUrl: string;
  apiKey: string;
  approval: AssistantApprovalMode;
  toolGroups: AssistantToolGroup[];
  /** Lowest role that may use the assistant (on any server). */
  minRole: Role;
  /** Model calls per request before the assistant has to stop and answer. */
  maxSteps: number;
  /** Extra guidance added to the system prompt, e.g. house rules for the community. */
  instructions: string;
}

export const ASSISTANT_DEFAULTS: AssistantSettings = {
  enabled: false,
  provider: "anthropic",
  model: ASSISTANT_PROVIDER_INFO.anthropic.defaultModel,
  baseUrl: "",
  apiKey: "",
  approval: "always",
  toolGroups: [...ASSISTANT_TOOL_GROUPS].filter((g) => g !== "files"),
  minRole: "operator",
  maxSteps: 10,
  instructions: "",
};

export const assistantSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(ASSISTANT_PROVIDERS),
  model: z.string().trim().max(200),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((s) => s === "" || /^https?:\/\/[^\s]+$/i.test(s), "Enter an http(s) URL"),
  apiKey: z.string().trim().max(500),
  approval: z.enum(ASSISTANT_APPROVAL_MODES),
  toolGroups: z.array(z.enum(ASSISTANT_TOOL_GROUPS)).max(ASSISTANT_TOOL_GROUPS.length),
  minRole: z.enum(ROLES),
  maxSteps: z.number().int().min(1).max(30),
  instructions: z.string().max(4000),
});

export const assistantMessageSchema = z.object({
  /** Omit to start a new conversation. */
  conversationId: z.string().max(64).optional(),
  /** The server the user has open; the assistant treats it as "this server". */
  serverId: z.string().max(64).nullable().optional(),
  message: z.string().trim().min(1).max(4000),
});

export const assistantDecisionSchema = z.object({
  toolCallId: z.string().max(200),
  approve: z.boolean(),
});

export type AssistantRisk = "read" | "change" | "risky";
export type AssistantToolState = "waiting" | "running" | "done" | "failed" | "rejected";

export type AssistantItem =
  | { kind: "user"; text: string; at: number }
  | { kind: "assistant"; text: string; at: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** Plain-language description of what the call does, e.g. "Restart survival". */
      title: string;
      input: Record<string, unknown>;
      risk: AssistantRisk;
      state: AssistantToolState;
      /** Short result or error shown under the call. */
      result?: string;
      at: number;
    }
  | { kind: "error"; text: string; at: number };

export interface AssistantConversationView {
  id: string;
  serverId: string | null;
  /** "awaiting": a change waits for approval; "running": the model or a tool is working. */
  status: "idle" | "running" | "awaiting";
  items: AssistantItem[];
  updatedAt: number;
}

/** What the dashboard needs to know to show (or hide) the assistant. */
export interface AssistantStatus {
  enabled: boolean;
  /** Configured and allowed for this user. */
  available: boolean;
  provider: AssistantProvider;
  model: string;
  approval: AssistantApprovalMode;
  reason: string | null;
}
