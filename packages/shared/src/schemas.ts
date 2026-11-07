import { z } from "zod";
import { ROLES } from "./roles";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Only letters, digits, '.', '_' and '-' are allowed");

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(256);

export const setupSchema = z.object({ username: usernameSchema, password: passwordSchema });
export const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(ROLES),
});
export const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  password: passwordSchema.optional(),
});
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });

/** JVM args are passed as an argv array; we reject anything that is not a JVM option. */
export const jvmArgsSchema = z
  .string()
  .max(2000)
  .refine(
    (s) => s.trim() === "" || s.trim().split(/\s+/).every((a) => /^-[A-Za-z0-9:_.+=,\-/@%]+$/.test(a)),
    "Each JVM argument must start with '-' and contain no shell characters",
  )
  .refine((s) => !/(^|\s)-Xm[sx]/i.test(s), "Use the memory slider instead of -Xms/-Xmx")
  .refine((s) => !/(^|\s)-(jar|cp|classpath)\b/.test(s), "-jar and -cp are managed by CraftPanel");

export const serverNameSchema = z.string().trim().min(1, "Name is required").max(48);
export const portSchema = z.number().int().min(1024, "Use a port of 1024 or above").max(65535);
export const seedSchema = z.string().max(64).optional().default("");
export const mcIdentifierSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "Invalid version identifier");
export const levelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 _.-]+$/, "World names may contain letters, digits, spaces, '.', '_' and '-'")
  .refine((s) => s !== "." && s !== ".." && !s.startsWith("."), "Invalid world name");

export const GAMEMODES = ["survival", "creative", "adventure", "spectator"] as const;
export const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"] as const;

export const createServerSchema = z.object({
  name: serverNameSchema,
  description: z.string().max(280).optional().default(""),
  edition: z.literal("java").default("java"),
  software: z.enum(["vanilla", "paper"]),
  mcVersion: mcIdentifierSchema,
  build: z.string().max(32).nullable().optional(),
  levelName: levelNameSchema.default("world"),
  seed: seedSchema,
  levelType: z.enum(["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified"]).default("minecraft:normal"),
  generateStructures: z.boolean().default(true),
  gamemode: z.enum(GAMEMODES).default("survival"),
  hardcore: z.boolean().default(false),
  difficulty: z.enum(DIFFICULTIES).default("normal"),
  maxPlayers: z.number().int().min(1).max(1000).default(20),
  whitelist: z.boolean().default(false),
  onlineMode: z.boolean().default(true),
  motd: z.string().max(120).default("A CraftPanel server"),
  memoryMb: z.number().int().min(512).max(262144).default(2048),
  jvmArgs: jvmArgsSchema.default(""),
  javaPath: z.string().max(1024).nullable().optional(),
  networkMode: z.enum(["lan", "wan"]).default("lan"),
  bindAddress: z.string().max(64).default(""),
  port: portSchema.default(25565),
  directory: z.string().max(1024).optional(),
  acceptEula: z.boolean().default(false),
  autoStart: z.boolean().default(false),
});
export type CreateServerInput = z.input<typeof createServerSchema>;

export const updateServerSchema = z.object({
  name: serverNameSchema.optional(),
  description: z.string().max(280).optional(),
  memoryMb: z.number().int().min(512).max(262144).optional(),
  jvmArgs: jvmArgsSchema.optional(),
  javaPath: z.string().max(1024).nullable().optional(),
  autoStart: z.boolean().optional(),
  networkMode: z.enum(["lan", "wan"]).optional(),
});

export const commandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((s) => !/[\r\n\0]/.test(s), "Commands must be a single line"),
});

export const propertiesUpdateSchema = z.object({
  values: z.record(z.string().regex(/^[a-z0-9.\-_]+$/), z.string().max(4096).refine((s) => !/[\r\n]/.test(s), "Values must be a single line")),
});

export const gameruleUpdateSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_:.]+$/).max(80),
  value: z.string().regex(/^(true|false|-?\d{1,10})$/),
});

export const playerNameSchema = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, "Invalid Minecraft username");
export const playerActionSchema = z.object({
  name: playerNameSchema,
  reason: z
    .string()
    .max(200)
    .optional()
    .refine((s) => s === undefined || !/[\r\n]/.test(s), "Reason must be a single line"),
});
export const ipBanSchema = z.object({
  ip: z.union([z.ipv4(), z.ipv6()]),
  reason: z.string().max(200).optional(),
});

export const backupCreateSchema = z.object({ note: z.string().max(200).optional() });

export const scheduleSchema = z.object({
  serverId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(64),
  cron: z.string().trim().min(1).max(120),
  action: z.enum(["start", "restart", "stop", "backup", "announce", "command", "prune-backups", "cleanup-logs"]),
  payload: z
    .object({
      message: z.string().max(256).optional(),
      command: z.string().max(1000).optional(),
      keep: z.number().int().min(1).max(1000).optional(),
      olderThanDays: z.number().int().min(1).max(3650).optional(),
      warnSeconds: z.number().int().min(0).max(600).optional(),
    })
    .default({}),
  enabled: z.boolean().default(true),
});

export const appSettingsSchema = z.object({
  backupDirectory: z.string().max(1024).optional(),
  backupRetention: z.number().int().min(1).max(1000).optional(),
  ddnsProvider: z.enum(["none", "duckdns"]).optional(),
  ddnsDomain: z.string().max(253).regex(/^[a-z0-9.-]*$/i).optional(),
  ddnsToken: z.string().max(200).optional(),
});

export const fileWriteSchema = z.object({ path: z.string().max(4096), content: z.string().max(5 * 1024 * 1024) });
export const filePathSchema = z.object({ path: z.string().max(4096) });
export const fileRenameSchema = z.object({ from: z.string().max(4096), to: z.string().max(4096) });

export const worldCreateSchema = z.object({
  name: levelNameSchema,
  seed: z.string().max(64).optional(),
  levelType: z.enum(["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified"]).optional(),
  activate: z.boolean().default(true),
});
