import { z } from "zod";
import {
  AppError,
  canAccess,
  canSeeServer,
  commandSchema,
  playerNameSchema,
  scheduleSchema,
  type AssistantRisk,
  type AssistantToolGroup,
  type Permission,
} from "@craftpanel/shared";
import type { SessionUser } from "../../auth/sessions";
import type { AppContext } from "../../context";
import type { Actor } from "../activity";
import type { ServerRow } from "../servers";
import type { ToolSpec } from "./llm";

// The assistant's tools. Each one names the permission it needs on the server it touches and how risky it is;
// the conversation checks both with the asking user's own access before anything runs, and the services do the
// work exactly as the dashboard's routes would (including their audit entries).

export interface ToolEnv {
  ctx: AppContext;
  user: SessionUser;
  actor: Actor;
  /** The server the user had open, used when the model leaves `server` out. */
  defaultServerId: string | null;
}

export interface PreparedCall {
  title: string;
  risk: AssistantRisk;
  run: () => Promise<unknown>;
}

interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  group: AssistantToolGroup;
  description: string;
  input: S;
  /** Checks access and describes the call; throws AppError when the user may not do it. */
  prepare: (input: z.output<S>, env: ToolEnv) => Promise<PreparedCall>;
}

const tool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

const serverField = z
  .string()
  .max(100)
  .optional()
  .describe("Server name or id. Leave out to use the server the user has open.");

/** Files the panel manages itself; never readable or writable through the assistant. */
const PROTECTED_FILE = /^\.craftpanel$/;
/** server.properties keys holding secrets. */
const SECRET_PROPERTY = /(password|secret|token)/i;

/** Finds the server the model means among the ones this user can see. */
async function resolveServer(env: ToolEnv, ref: string | undefined): Promise<ServerRow> {
  const rows = (await env.ctx.servers.rows()).filter((r) => canSeeServer(env.user, r.id));
  const wanted = (ref ?? env.defaultServerId ?? "").trim();
  if (!wanted) {
    if (rows.length === 1) return rows[0];
    throw new AppError(400, "server_required", `Say which server: ${rows.map((r) => r.name).join(", ") || "there are no servers"}`);
  }
  const lower = wanted.toLowerCase();
  const match = rows.find((r) => r.id === wanted) ?? rows.find((r) => r.name.toLowerCase() === lower);
  if (!match) throw new AppError(404, "not_found", `No server called "${wanted}". Servers: ${rows.map((r) => r.name).join(", ") || "none"}`);
  return match;
}

function need(env: ToolEnv, permission: Permission, row: ServerRow) {
  if (!canAccess(env.user, permission, row.id))
    throw new AppError(403, "forbidden", `${env.user.username} does not have the "${permission}" permission on ${row.name}`);
}

const TOOLS: ToolDef[] = [
  tool({
    name: "list_servers",
    group: "servers",
    description: "List the Minecraft servers the user can see, with status, software, version and players online.",
    input: z.object({}),
    async prepare(_input, env) {
      return {
        title: "List servers",
        risk: "read",
        run: async () =>
          (await env.ctx.servers.rows())
            .filter((r) => canSeeServer(env.user, r.id))
            .map((r) => {
              const s = env.ctx.servers.summary(r);
              return { id: s.id, name: s.name, software: s.software, version: s.mcVersion, status: s.status, players: `${s.playersOnline}/${s.maxPlayers}`, port: s.port, memoryMb: s.memoryMb, restartRequired: s.restartRequired };
            }),
      };
    },
  }),
  tool({
    name: "server_status",
    group: "servers",
    description: "Status and live performance of one server: TPS, MSPT, CPU, memory, uptime, players, and whether a task is running.",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `Check ${row.name}`,
        risk: "read",
        run: async () => {
          const s = env.ctx.servers.summary(row);
          return { ...s, metrics: env.ctx.servers.agent.latestMetrics(row.id), busy: env.ctx.servers.busy(row.id) };
        },
      };
    },
  }),
  tool({
    name: "server_power",
    group: "servers",
    description: "Start, stop or restart a server. Stopping disconnects every player.",
    input: z.object({ server: serverField, action: z.enum(["start", "stop", "restart"]) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.control", row);
      const verb = { start: "Start", stop: "Stop", restart: "Restart" }[input.action];
      return {
        title: `${verb} ${row.name}`,
        risk: input.action === "stop" ? "risky" : "change",
        run: async () => {
          if (input.action === "start") await env.ctx.servers.start(row.id, env.actor);
          else if (input.action === "stop") await env.ctx.servers.stop(row.id, env.actor);
          else
            void env.ctx.servers.restart(row.id, env.actor).catch((err) =>
              env.ctx.activity.event(row.id, "server.restart_failed", `Restart failed: ${(err as Error).message}`, { level: "error" }),
            );
          return { ok: true, note: input.action === "start" ? "Starting. Check server_status in a moment." : `${verb} requested.` };
        },
      };
    },
  }),
  tool({
    name: "read_console",
    group: "console",
    description: "Read the latest console lines of a server, optionally only lines containing some text (case-insensitive).",
    input: z.object({ server: serverField, lines: z.number().int().min(1).max(300).optional().describe("Default 60"), contains: z.string().max(100).optional() }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "console.read", row);
      return {
        title: `Read the console of ${row.name}`,
        risk: "read",
        run: async () => {
          let lines = env.ctx.servers.agent.history(row.id, 2000);
          if (input.contains) lines = lines.filter((l) => l.text.toLowerCase().includes(input.contains!.toLowerCase()));
          return lines.slice(-(input.lines ?? 60)).map((l) => `${new Date(l.ts).toISOString().slice(11, 19)} ${l.text}`);
        },
      };
    },
  }),
  tool({
    name: "run_command",
    group: "console",
    description: "Send one Minecraft console command (without the leading slash) to a running server and return the console lines it produced.",
    input: z.object({ server: serverField, command: z.string().max(1000) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "console.command", row);
      const { command } = commandSchema.parse({ command: input.command.replace(/^\//, "") });
      return {
        title: `Run "${command}" on ${row.name}`,
        risk: "risky",
        run: async () => {
          const before = env.ctx.servers.agent.history(row.id, 1).at(-1)?.seq ?? -1;
          await env.ctx.servers.sendCommand(row.id, command);
          await env.ctx.activity.audit(env.actor, "console.command", row.id, { command });
          await new Promise((r) => setTimeout(r, 1500));
          const out = env.ctx.servers.agent.history(row.id, 200).filter((l) => l.seq > before && l.stream !== "command");
          return { sent: command, output: out.slice(0, 40).map((l) => l.text) };
        },
      };
    },
  }),
  tool({
    name: "list_players",
    group: "players",
    description: "Players online, the whitelist (and whether it is on), operators and banned players of a server.",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `List players on ${row.name}`,
        risk: "read",
        run: async () => {
          const p = await env.ctx.game.players(row);
          return {
            online: p.online.map((o) => o.name),
            whitelistEnabled: p.whitelistEnabled,
            whitelist: p.whitelist.map((w) => w.name),
            operators: p.ops.map((o) => o.name),
            banned: p.bans.map((b) => ({ name: b.name, reason: b.reason })),
          };
        },
      };
    },
  }),
  tool({
    name: "player_action",
    group: "players",
    description: "Change a player's access: whitelist-add, whitelist-remove, op, deop, kick, ban or pardon. Works while the server is stopped too (except kick).",
    input: z.object({
      server: serverField,
      action: z.enum(["whitelist-add", "whitelist-remove", "op", "deop", "kick", "ban", "pardon"]),
      player: playerNameSchema,
      reason: z.string().max(200).regex(/^[^\r\n]*$/).optional(),
    }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "players.manage", row);
      if (input.action === "op" || input.action === "deop") need(env, "server.configure", row);
      const titles: Record<string, string> = {
        "whitelist-add": `Add ${input.player} to the whitelist of ${row.name}`,
        "whitelist-remove": `Remove ${input.player} from the whitelist of ${row.name}`,
        op: `Make ${input.player} an operator on ${row.name}`,
        deop: `Remove operator from ${input.player} on ${row.name}`,
        kick: `Kick ${input.player} from ${row.name}`,
        ban: `Ban ${input.player} from ${row.name}`,
        pardon: `Unban ${input.player} on ${row.name}`,
      };
      return {
        title: titles[input.action],
        risk: input.action === "whitelist-add" || input.action === "pardon" ? "change" : "risky",
        run: async () => {
          // A running server takes the change as a console command; its answer tells whether it worked.
          const before = env.ctx.servers.agent.history(row.id, 1).at(-1)?.seq ?? -1;
          await env.ctx.game.playerAction(row, input.action, input.player, input.reason, env.actor);
          const output = env.ctx.servers.agent.history(row.id, 50).filter((l) => l.seq > before && l.stream !== "command").map((l) => l.text);
          return output.length ? { ok: true, console: output.slice(0, 10) } : { ok: true };
        },
      };
    },
  }),
  tool({
    name: "list_plugins",
    group: "plugins",
    description: "Installed plugins or mods of a server with versions and whether they are enabled.",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `List add-ons on ${row.name}`,
        risk: "read",
        run: async () =>
          (await env.ctx.game.plugins(row)).map((p) => ({ file: p.file, name: p.name, version: p.version, enabled: p.enabled, description: p.description?.slice(0, 160) ?? null })),
      };
    },
  }),
  tool({
    name: "search_plugins",
    group: "plugins",
    description: "Search Modrinth for plugins or mods compatible with the server's software and Minecraft version.",
    input: z.object({ server: serverField, query: z.string().min(1).max(100) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "plugins.manage", row);
      return {
        title: `Search Modrinth for "${input.query}"`,
        risk: "read",
        run: async () => {
          const res = await env.ctx.game.searchModrinth(row, input.query, 0);
          return res.hits.slice(0, 8).map((h) => ({ projectId: h.id, title: h.title, description: h.description, author: h.author, downloads: h.downloads, compatible: h.compatible, installed: h.installed }));
        },
      };
    },
  }),
  tool({
    name: "install_plugin",
    group: "plugins",
    description: "Install the newest compatible version of a Modrinth project (by projectId from search_plugins). Takes effect after a restart.",
    input: z.object({ server: serverField, projectId: z.string().min(1).max(64), title: z.string().max(100).optional().describe("Project title, for the approval prompt") }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "plugins.manage", row);
      return {
        title: `Install ${input.title ?? input.projectId} on ${row.name}`,
        risk: "risky",
        run: async () => env.ctx.game.installFromModrinth(row, input.projectId, undefined, env.actor),
      };
    },
  }),
  tool({
    name: "list_backups",
    group: "backups",
    description: "Backups of a server, newest first.",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `List backups of ${row.name}`,
        risk: "read",
        run: async () =>
          (await env.ctx.backups.list(row.id)).slice(0, 20).map((b) => ({ id: b.id, kind: b.kind, status: b.status, sizeBytes: b.size, note: b.note, created: new Date(b.createdAt).toISOString() })),
      };
    },
  }),
  tool({
    name: "create_backup",
    group: "backups",
    description: "Start a backup of a server. It runs in the background; list_backups shows when it is done.",
    input: z.object({ server: serverField, note: z.string().max(200).optional() }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "backup.create", row);
      return {
        title: `Back up ${row.name}`,
        risk: "change",
        run: async () => {
          void env.ctx.backups.create(row.id, "manual", env.actor, input.note).catch(() => undefined);
          return { ok: true, note: "Backup started." };
        },
      };
    },
  }),
  tool({
    name: "list_schedules",
    group: "schedules",
    description: "Scheduled tasks of a server (cron, action, next run).",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `List automation on ${row.name}`,
        risk: "read",
        run: async () =>
          (await env.ctx.schedules.list(row.id)).map((s) => ({ name: s.name, cron: s.cron, action: s.action, payload: s.payload, enabled: s.enabled, nextRun: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null })),
      };
    },
  }),
  tool({
    name: "create_schedule",
    group: "schedules",
    description:
      "Create a scheduled task. cron uses five fields in the panel's local time, e.g. '0 4 * * *' for 04:00 daily. Actions: start, restart, stop, backup, announce (payload.message), command (payload.command), prune-backups (payload.keep), cleanup-logs (payload.olderThanDays). restart and stop take payload.warnSeconds.",
    input: z.object({
      server: serverField,
      name: z.string().min(1).max(64),
      cron: z.string().min(1).max(120),
      action: scheduleSchema.shape.action,
      payload: z
        .object({
          message: z.string().max(256).optional(),
          command: z.string().max(1000).optional(),
          keep: z.number().int().min(1).max(1000).optional(),
          olderThanDays: z.number().int().min(1).max(3650).optional(),
          warnSeconds: z.number().int().min(0).max(600).optional(),
        })
        .optional(),
    }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "schedule.manage", row);
      const schedule = scheduleSchema.parse({ serverId: row.id, name: input.name, cron: input.cron, action: input.action, payload: input.payload ?? {} });
      return {
        title: `Schedule "${schedule.name}" (${schedule.action}, ${schedule.cron}) on ${row.name}`,
        risk: schedule.action === "command" || schedule.action === "stop" ? "risky" : "change",
        run: async () => {
          const created = await env.ctx.schedules.create(schedule, env.actor);
          return { ok: true, nextRun: created.nextRunAt ? new Date(created.nextRunAt).toISOString() : null };
        },
      };
    },
  }),
  tool({
    name: "read_properties",
    group: "settings",
    description: "Read server.properties of a server (difficulty, gamemode, max-players, view-distance, motd, …). Secrets are left out.",
    input: z.object({ server: serverField }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.view", row);
      return {
        title: `Read the settings of ${row.name}`,
        risk: "read",
        run: async () => {
          const { values } = await env.ctx.game.readProperties(row);
          return Object.fromEntries(Object.entries(values).filter(([k]) => !SECRET_PROPERTY.test(k)));
        },
      };
    },
  }),
  tool({
    name: "update_properties",
    group: "settings",
    description: "Change server.properties values (key → string value). Most changes need a restart. Port and world settings are managed elsewhere and are rejected.",
    input: z.object({
      server: serverField,
      values: z.record(z.string().regex(/^[a-z0-9.\-_]+$/), z.string().max(4096).regex(/^[^\r]*$/)),
    }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "server.configure", row);
      const keys = Object.keys(input.values);
      if (!keys.length) throw new AppError(400, "validation_error", "No values to change");
      if (keys.some((k) => SECRET_PROPERTY.test(k))) throw new AppError(403, "forbidden", "Secrets in server.properties can only be changed in the dashboard");
      return {
        title: `Change ${keys.map((k) => `${k}=${input.values[k]}`).join(", ")} on ${row.name}`,
        risk: "change",
        run: async () => {
          await env.ctx.game.updateProperties(row, input.values, env.actor);
          return { ok: true, restartRequired: env.ctx.servers.agent.isRunning(row.id) };
        },
      };
    },
  }),
  tool({
    name: "list_files",
    group: "files",
    description: "List a folder inside a server's directory ('' is the server's root).",
    input: z.object({ server: serverField, path: z.string().max(1024) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "files.read", row);
      return {
        title: `List ${input.path || "the server folder"} of ${row.name}`,
        risk: "read",
        run: async () =>
          (await env.ctx.servers.sandbox(row).list(input.path))
            .filter((e) => !PROTECTED_FILE.test(e.name))
            .slice(0, 200)
            .map((e) => ({ name: e.name, type: e.type, size: e.size })),
      };
    },
  }),
  tool({
    name: "read_file",
    group: "files",
    description: "Read a text file inside a server's directory, e.g. plugins/Essentials/config.yml. Long files are cut off.",
    input: z.object({ server: serverField, path: z.string().min(1).max(1024) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "files.read", row);
      guardFile(input.path);
      return {
        title: `Read ${input.path} on ${row.name}`,
        risk: "read",
        run: async () => {
          const text = await env.ctx.servers.sandbox(row).readText(input.path);
          return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (cut off, ${text.length} characters in total)` : text;
        },
      };
    },
  }),
  tool({
    name: "write_file",
    group: "files",
    description: "Replace the whole content of a text file inside a server's directory. Read it first and keep everything you do not mean to change.",
    input: z.object({ server: serverField, path: z.string().min(1).max(1024), content: z.string().max(1024 * 1024) }),
    async prepare(input, env) {
      const row = await resolveServer(env, input.server);
      need(env, "files.write", row);
      guardFile(input.path);
      return {
        title: `Write ${input.path} on ${row.name} (${input.content.length} characters)`,
        risk: "risky",
        run: async () => {
          await env.ctx.servers.sandbox(row).writeText(input.path, input.content);
          await env.ctx.activity.audit(env.actor, "file.write", row.id, { path: input.path });
          return { ok: true };
        },
      };
    },
  }),
];

function guardFile(rel: string) {
  const top = rel.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0];
  if (PROTECTED_FILE.test(top)) throw new AppError(403, "forbidden", "This file is managed by CraftPanel");
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsFor(groups: AssistantToolGroup[]): ToolDef[] {
  return TOOLS.filter((t) => groups.includes(t.group));
}

export function toolSpecs(tools: ToolDef[]): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

/** Validates a call and checks access; the result says what it would do. */
export async function prepareCall(name: string, rawInput: unknown, allowed: AssistantToolGroup[], env: ToolEnv): Promise<PreparedCall> {
  const def = BY_NAME.get(name);
  if (!def || !allowed.includes(def.group)) throw new AppError(400, "unknown_tool", `The tool "${name}" is not available`);
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new AppError(400, "validation_error", `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  return def.prepare(parsed.data, env);
}
