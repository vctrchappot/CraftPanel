import { z } from "zod";

/**
 * An application backup is one zip file:
 *   manifest.json                    what is inside (below)
 *   database.sqlite                  consistent copy of craftpanel.db (users, settings, servers, schedules, rules, ...)
 *   config/environment.env           the CRAFTPANEL_* settings the dashboard was started with
 *   config/tls-cert.pem, tls-key.pem built-in HTTPS certificate and key, when configured
 *   servers/<id>.zip                 each server's files and worlds (same format as a server backup)
 * It holds secrets (password hashes, API keys, the TLS key), so it is as sensitive as the data directory.
 */
export const APP_BACKUP_FORMAT = 1;
export const APP_BACKUP_PREFIX = "craftpanel-app-";

const serverId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const appBackupManifestSchema = z.object({
  format: z.literal(APP_BACKUP_FORMAT),
  createdAt: z.string().max(40),
  craftpanelVersion: z.string().regex(/^\d+\.\d+\.\d+/).max(40),
  platform: z.string().max(20),
  hostname: z.string().max(255),
  database: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  config: z.object({ variables: z.array(z.string().max(100)).max(200) }).nullable(),
  tls: z.boolean(),
  servers: z.array(z.object({
    id: serverId,
    name: z.string().max(200),
    /** Entry name of the server's archive; null when the files were not included. */
    archive: z.string().regex(/^servers\/[A-Za-z0-9_-]{1,64}\.zip$/).nullable(),
  })).max(1000),
});
export type AppBackupManifest = z.infer<typeof appBackupManifestSchema>;

/** `KEY=value` lines for the CRAFTPANEL_* variables, quoted only where a plain value would not survive. */
export function formatEnvironment(env: NodeJS.ProcessEnv): { text: string; variables: string[] } {
  const variables = Object.keys(env).filter((k) => /^CRAFTPANEL_[A-Z0-9_]+$/.test(k) && env[k] !== undefined && env[k] !== "").sort();
  const quote = (v: string) => (/^[\w@%+=:,./\\-]*$/.test(v) ? v : JSON.stringify(v));
  return { variables, text: variables.map((k) => `${k}=${quote(env[k]!)}`).join("\n") + (variables.length ? "\n" : "") };
}
