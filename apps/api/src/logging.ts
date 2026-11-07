import { Writable } from "node:stream";

/**
 * Human-readable console output for Fastify's pino logger.
 *
 * Per-request lines ("incoming request" / "request completed") are dropped unless the
 * level is debug/trace or the request failed with a 5xx, so the terminal shows what
 * matters: startup, server lifecycle, warnings and errors.
 */
const LEVELS: Record<number, { name: string; color: string }> = {
  10: { name: "TRACE", color: "\x1b[90m" },
  20: { name: "DEBUG", color: "\x1b[90m" },
  30: { name: "INFO ", color: "\x1b[36m" },
  40: { name: "WARN ", color: "\x1b[33m" },
  50: { name: "ERROR", color: "\x1b[31m" },
  60: { name: "FATAL", color: "\x1b[41m\x1b[97m" },
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

interface LogRecord {
  level: number;
  time: number;
  msg?: string;
  reqId?: string;
  req?: { method: string; url: string; remoteAddress?: string };
  res?: { statusCode: number };
  responseTime?: number;
  err?: { type?: string; message?: string; stack?: string };
}

export function prettyLogStream(opts: { level: string; color?: boolean; out?: NodeJS.WritableStream }): Writable {
  const out = opts.out ?? process.stdout;
  const color = opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
  const verboseRequests = opts.level === "debug" || opts.level === "trace";
  const paint = (c: string, s: string) => (color ? c + s + RESET : s);
  let pending = "";
  // "request completed" carries no URL; remember it from "incoming request" until then.
  const inflight = new Map<string, string>();

  const format = (rec: LogRecord): string | null => {
    let msg = rec.msg ?? "";
    // Redundant with CraftPanel's startup banner / routine 404s for unknown paths.
    if (!verboseRequests && rec.level < 40 && (msg.startsWith("Server listening at ") || /^Route \S+ not found$/.test(msg))) return null;
    if (msg === "incoming request") {
      if (rec.reqId && rec.req) {
        inflight.set(rec.reqId, `${rec.req.method} ${rec.req.url.split("?")[0]}`);
        if (inflight.size > 1000) inflight.delete(inflight.keys().next().value!);
      }
      if (!verboseRequests) return null;
      msg = `→ ${rec.req ? `${rec.req.method} ${rec.req.url}` : ""}`;
    } else if (msg === "request completed") {
      const target = (rec.reqId && inflight.get(rec.reqId)) || rec.reqId || "request";
      if (rec.reqId) inflight.delete(rec.reqId);
      const status = rec.res?.statusCode ?? 0;
      if (!verboseRequests && status < 500) return null;
      msg = `${target} → ${status} (${Math.round(rec.responseTime ?? 0)} ms)`;
    }
    const lvl = LEVELS[rec.level] ?? LEVELS[30]!;
    const time = new Date(rec.time).toTimeString().slice(0, 8);
    let line = `${paint(DIM, time)} ${paint(lvl.color, lvl.name)} ${msg}`;
    if (rec.err) {
      const detail = rec.err.stack ?? `${rec.err.type ?? "Error"}: ${rec.err.message ?? ""}`;
      if (!msg.includes(rec.err.message ?? "\0")) line += ` ${rec.err.message ?? ""}`;
      if (rec.level >= 50) line += "\n" + paint(DIM, detail.split("\n").map((l) => "    " + l).join("\n"));
    }
    return line + "\n";
  };

  return new Writable({
    write(chunk, _enc, cb) {
      pending += chunk.toString();
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const raw = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!raw.trim()) continue;
        try {
          const line = format(JSON.parse(raw) as LogRecord);
          if (line) out.write(line);
        } catch {
          out.write(raw + "\n");
        }
      }
      cb();
    },
  });
}
