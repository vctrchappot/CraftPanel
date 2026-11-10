import { z } from "zod";
import { ROLES, type Role } from "./roles";

// The optional AI assistant: the owner brings an API key for a model provider, and users ask in plain language.
// The assistant acts through tools with the asking user's own permissions; changes wait for approval.

/**
 * Anthropic speaks its Messages API; every other provider speaks Chat Completions at its own address.
 * "openai-compatible" is any other Chat Completions API, at a base URL the owner enters.
 */
export const ASSISTANT_PROVIDERS = ["anthropic", "openai", "deepseek", "gemini", "openrouter", "mistral", "groq", "ollama", "lmstudio", "openai-compatible"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export interface AssistantProviderInfo {
  label: string;
  /** One line under the name in the provider picker. */
  note: string;
  /** "" = pick one from the provider's model list. */
  defaultModel: string;
  /** "" = the owner has to enter one. */
  defaultBaseUrl: string;
  keyRequired: boolean;
  /** Runs on the owner's own machine: no key, nothing leaves the network. */
  local: boolean;
  /** Where to create an API key. */
  keyUrl: string | null;
  keyPlaceholder: string;
}

export const ASSISTANT_PROVIDER_INFO: Record<AssistantProvider, AssistantProviderInfo> = {
  anthropic: { label: "Anthropic", note: "Claude", defaultModel: "claude-opus-5-5", defaultBaseUrl: "https://api.anthropic.com", keyRequired: true, local: false, keyUrl: "https://console.anthropic.com/settings/keys", keyPlaceholder: "sk-ant-…" },
  openai: { label: "OpenAI", note: "GPT models", defaultModel: "", defaultBaseUrl: "https://api.openai.com/v1", keyRequired: true, local: false, keyUrl: "https://platform.openai.com/api-keys", keyPlaceholder: "sk-…" },
  deepseek: { label: "DeepSeek", note: "DeepSeek chat and reasoner", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1", keyRequired: true, local: false, keyUrl: "https://platform.deepseek.com/api_keys", keyPlaceholder: "sk-…" },
  gemini: { label: "Google Gemini", note: "Gemini via its OpenAI endpoint", defaultModel: "", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyRequired: true, local: false, keyUrl: "https://aistudio.google.com/apikey", keyPlaceholder: "AIza…" },
  openrouter: { label: "OpenRouter", note: "Many models, one key", defaultModel: "", defaultBaseUrl: "https://openrouter.ai/api/v1", keyRequired: true, local: false, keyUrl: "https://openrouter.ai/settings/keys", keyPlaceholder: "sk-or-…" },
  mistral: { label: "Mistral", note: "Mistral and Codestral", defaultModel: "", defaultBaseUrl: "https://api.mistral.ai/v1", keyRequired: true, local: false, keyUrl: "https://console.mistral.ai/api-keys", keyPlaceholder: "API key" },
  groq: { label: "Groq", note: "Fast open models", defaultModel: "", defaultBaseUrl: "https://api.groq.com/openai/v1", keyRequired: true, local: false, keyUrl: "https://console.groq.com/keys", keyPlaceholder: "gsk_…" },
  ollama: { label: "Ollama", note: "On this computer, no key", defaultModel: "", defaultBaseUrl: "http://localhost:11434/v1", keyRequired: false, local: true, keyUrl: null, keyPlaceholder: "" },
  lmstudio: { label: "LM Studio", note: "On this computer, no key", defaultModel: "", defaultBaseUrl: "http://localhost:1234/v1", keyRequired: false, local: true, keyUrl: null, keyPlaceholder: "" },
  "openai-compatible": { label: "Other", note: "Any OpenAI-compatible API", defaultModel: "", defaultBaseUrl: "", keyRequired: false, local: false, keyUrl: null, keyPlaceholder: "Optional" },
};

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

/** Live cards the assistant can put into the conversation; the dashboard fills them with current data. */
export const ASSISTANT_CARDS = ["status", "performance", "players", "console", "backups"] as const;
export type AssistantCard = (typeof ASSISTANT_CARDS)[number];

export interface AssistantEmbed {
  card: AssistantCard;
  serverId: string;
  serverName: string;
  /** Console card: only lines containing this text. */
  filter?: string;
}

export type AssistantRisk = "read" | "change" | "risky";
export type AssistantToolState = "waiting" | "running" | "done" | "failed" | "rejected";

export type AssistantItem =
  | { kind: "user"; text: string; at: number }
  /** `streaming`: the model is still writing this answer. */
  | { kind: "assistant"; text: string; at: number; streaming?: boolean }
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
      /** A live card the dashboard draws in the conversation (the show_card tool). */
      embed?: AssistantEmbed;
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
