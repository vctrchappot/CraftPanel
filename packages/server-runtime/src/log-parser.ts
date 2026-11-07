import type { LogLevel } from "@craftpanel/shared";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const SECTION = /§[0-9a-fk-or]/gi;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "").replace(SECTION, "");
}

/** Strip the timestamp/thread prefix produced by vanilla and Paper loggers. */
const PREFIX = /^\[(\d{2}:\d{2}:\d{2})(?:\s+(INFO|WARN|ERROR|DEBUG|FATAL|TRACE))?\]\s*(?:\[([^\]]*)\/(INFO|WARN|ERROR|DEBUG|FATAL|TRACE)\]\s*)?:\s?(.*)$/;

export interface ParsedLine {
  level: LogLevel;
  thread: string | null;
  message: string;
}

export function parseLine(raw: string): ParsedLine {
  const line = stripAnsi(raw);
  const m = PREFIX.exec(line);
  if (!m) {
    const level: LogLevel = /\b(Exception|Error)\b/.test(line) && /^\s*(at |Caused by|[\w.$]+(Exception|Error))/.test(line) ? "ERROR" : "UNKNOWN";
    return { level, thread: null, message: line };
  }
  const lvl = (m[2] ?? m[4] ?? "INFO") as string;
  const level = (lvl === "TRACE" ? "DEBUG" : lvl) as LogLevel;
  // 26.x prefixes command feedback with "System chat: "; normalise it away for matching.
  return { level, thread: m[3] ?? null, message: (m[5] ?? "").replace(/^System chat: /, "") };
}

export type LogSignal =
  | { kind: "done"; seconds: number | null }
  | { kind: "join"; name: string }
  | { kind: "leave"; name: string }
  | { kind: "uuid"; name: string; uuid: string }
  | { kind: "login"; name: string; ip: string }
  | { kind: "port-in-use"; detail: string }
  | { kind: "eula" }
  | { kind: "saved" }
  | { kind: "stopping" };

/** Recognize lifecycle- and player-related events in a log message. */
export function detectSignal(message: string): LogSignal | null {
  let m: RegExpExecArray | null;
  if ((m = /^Done \(([\d.,]+)s\)! For help, type/.exec(message))) return { kind: "done", seconds: Number(m[1].replace(",", ".")) };
  if (/^Done \(/.test(message)) return { kind: "done", seconds: null };
  if ((m = /^([A-Za-z0-9_]{1,16}) joined the game$/.exec(message))) return { kind: "join", name: m[1] };
  if ((m = /^([A-Za-z0-9_]{1,16}) left the game$/.exec(message))) return { kind: "leave", name: m[1] };
  if ((m = /^UUID of player ([A-Za-z0-9_]{1,16}) is ([0-9a-f-]{32,36})$/i.exec(message))) return { kind: "uuid", name: m[1], uuid: m[2] };
  if ((m = /^([A-Za-z0-9_]{1,16})\[\/([^\]]+?):\d+\] logged in with entity id/.exec(message))) return { kind: "login", name: m[1], ip: m[2] };
  if (/FAILED TO BIND TO PORT|Address already in use|Perhaps a server is already running on that port/i.test(message)) return { kind: "port-in-use", detail: message };
  if (/You need to agree to the EULA/i.test(message)) return { kind: "eula" };
  if (/^Saved the game$|^Saved the world$/i.test(message) || /^ThreadedAnvilChunkStorage.*All chunks are saved/.test(message)) return { kind: "saved" };
  if (/^Stopping (the )?server$/i.test(message)) return { kind: "stopping" };
  return null;
}

/** Paper `tps` output: "TPS from last 1m, 5m, 15m: 20.0, 19.98, *20.0". */
export function parseTps(message: string): number | null {
  const m = /TPS from last 1m, 5m, 15m:\s*\*?([\d.]+)/.exec(message);
  return m ? Number(m[1]) : null;
}

/** Vanilla `tick query` (1.20.3+): "Average time per tick: 1.2ms (Target: 50.0ms)". */
export function parseMspt(message: string): number | null {
  const m = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(message);
  return m ? Number(m[1]) : null;
}

export function parseListCount(message: string): { online: number; max: number; names: string[] } | null {
  const m = /There are (\d+) (?:of a max of|out of maximum) (\d+) players online[.:]?\s*(.*)$/i.exec(message);
  if (!m) return null;
  const names = m[3]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_]{1,16}$/.test(s));
  return { online: Number(m[1]), max: Number(m[2]), names };
}
