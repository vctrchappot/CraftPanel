import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config";

export interface DiagnosticCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  hint?: string;
}

/** Read-only checks: no migrations, downloads, process changes or test files. */
export async function deploymentDiagnostics(config: AppConfig, request?: { transportSecure: boolean }) {
  const checks: DiagnosticCheck[] = [];
  const add = (id: string, status: DiagnosticCheck["status"], message: string, hint?: string) => checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  add("listener", "ok", `Profile ${config.profile}; listener ${config.host}:${config.port}`);
  if (config.publicUrl) add("public-url", "ok", `Browser-facing address: ${config.publicUrl}`);
  else add("public-url", config.trustProxy ? "warning" : "ok", "No fixed browser-facing address configured", config.trustProxy ? "Set CRAFTPANEL_PUBLIC_URL to the external HTTPS origin." : undefined);
  if (config.trustProxy) {
    add("proxy-peers", "ok", `Forwarding headers accepted only from: ${config.trustProxy.join(", ")}`);
    if (!config.isLoopbackOnly && config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost")
      add("proxy-firewall", "warning", "The backend listener is reachable on a network interface", "Restrict its port to the configured proxy peers using the host firewall.");
  }
  if (config.publicUrl?.startsWith("https:") && !config.tls && !config.trustProxy)
    add("https-config", "error", "The public URL uses HTTPS but neither TLS nor trusted proxies are configured", "Configure built-in TLS or CRAFTPANEL_TRUSTED_PROXIES.");
  if (request) add("transport", request.transportSecure ? "ok" : "warning", request.transportSecure ? "This request arrived over HTTPS" : "This request arrived over plain HTTP", request.transportSecure ? undefined : "Use HTTPS or an encrypted private VPN.");
  else if (!config.tls) add("transport", "warning", config.trustProxy ? "External HTTPS cannot be verified from this command" : "The listener serves plain HTTP", config.trustProxy ? "Check Remote access in the dashboard through the external HTTPS address." : "Keep access on a trusted LAN/VPN, or configure HTTPS.");

  let dataPath = config.layout.root;
  try {
    // A first installation may not have a data directory yet. Check its nearest existing parent.
    while (true) {
      try {
        if (!(await fs.stat(dataPath)).isDirectory()) throw new Error("Data location is not a directory");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(dataPath) === dataPath) throw error;
        dataPath = path.dirname(dataPath);
      }
    }
    await fs.access(dataPath, constants.R_OK | constants.W_OK | constants.X_OK);
    add("data-access", "ok", `Data location is accessible to this OS account: ${config.layout.root}`);
    const stat = await fs.statfs(dataPath);
    const free = stat.bavail * stat.bsize;
    add("disk-space", free < 1024 ** 3 ? "warning" : "ok", `${Math.floor(free / 1024 ** 2)} MiB available on the data filesystem`, free < 1024 ** 3 ? "Free up space before running servers, updates or backups." : undefined);
  } catch {
    add("data-access", "error", "The data location is not accessible to this OS account", "Run doctor as the CraftPanel service user and check directory ownership and service ReadWritePaths.");
  }

  if (config.tls) {
    try {
      const cert = new X509Certificate(await fs.readFile(config.tls.certFile));
      const key = createPrivateKey(await fs.readFile(config.tls.keyFile));
      if (!cert.checkPrivateKey(key)) throw new Error("Certificate and key do not match");
      const days = Math.floor((Date.parse(cert.validTo) - Date.now()) / 86400_000);
      const future = Date.parse(cert.validFrom) > Date.now();
      add("certificate", days < 0 || future ? "error" : days < 14 ? "warning" : "ok", future ? "The TLS certificate is not valid yet" : `TLS certificate expires in ${days} days`, days < 14 ? "Renew the certificate and restart CraftPanel to load it." : undefined);
      if (config.publicUrl) {
        const hostname = new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, "");
        if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname)))
          add("certificate-host", "error", "The TLS certificate does not match the public URL hostname");
      }
    } catch {
      add("certificate", "error", "The TLS certificate or key cannot be read, or the certificate is invalid");
    }
  }

  try {
    await fs.access(config.layout.database);
    const db = new DatabaseSync(config.layout.database, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA quick_check(1)").get();
      const ok = row && Object.values(row)[0] === "ok";
      add("database", ok ? "ok" : "error", ok ? "SQLite quick check passed" : "SQLite reported an integrity problem");
    } finally { db.close(); }
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    add("database", absent ? "warning" : "error", absent ? "No database yet; first start initializes it" : "The database could not be checked", absent ? undefined : "Check access permissions and whether another operation holds the database lock.");
  }
  return { ok: !checks.some((c) => c.status === "error"), checks };
}
