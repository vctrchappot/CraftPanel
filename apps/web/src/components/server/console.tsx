"use client";

import * as React from "react";
import { ArrowDownToLine, Clock, Copy, Download, Eraser, Search } from "lucide-react";
import { Button, Input, NativeSelect, Tooltip, cn } from "@craftpanel/ui";
import type { ConsoleLine, ServerDetail } from "@craftpanel/shared";
import { toast } from "sonner";
import { useCan } from "@/lib/auth";
import { useConnectionState, useRealtime } from "@/lib/realtime";
import { formatTime } from "@/lib/format";
import { StatusBadge } from "../status";
import type { Stream } from "./workspace";

const LEVEL_CLASS: Record<string, string> = {
  ERROR: "text-red-400",
  FATAL: "text-red-400",
  WARN: "text-amber-300",
  DEBUG: "text-neutral-500",
};

export function ConsoleLines({ lines, autoScroll, showTime, className }: { lines: ConsoleLine[]; autoScroll: boolean; showTime?: boolean; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoScroll]);
  return (
    <div ref={ref} className={cn("scrollbar-thin overflow-y-auto px-4 py-3 font-mono text-[12px] leading-[1.6] text-console-foreground", className)} role="log" aria-live="off">
      {lines.length === 0 && <p className="text-neutral-500">No output yet.</p>}
      {lines.map((l) => (
        <div
          key={l.seq}
          className={cn(
            "whitespace-pre-wrap break-all [content-visibility:auto]",
            LEVEL_CLASS[l.level],
            l.stream === "command" && "text-sky-300",
            l.stream === "system" && "text-violet-300",
          )}
        >
          {showTime && <span className="mr-2 select-none text-neutral-500">{formatTime(l.ts)}</span>}
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function ConsoleTab({ server: s, stream }: { server: ServerDetail; stream: Stream }) {
  const rt = useRealtime();
  const conn = useConnectionState();
  const canCommand = useCan("console.command");
  const [query, setQuery] = React.useState("");
  const [level, setLevel] = React.useState("all");
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [showTime, setShowTime] = React.useState(false);
  const [input, setInput] = React.useState("");
  const historyKey = `cp-history-${s.id}`;
  const [history, setHistory] = React.useState<string[]>([]);
  const [hIndex, setHIndex] = React.useState(-1);
  const [clearedAt, setClearedAt] = React.useState(0);

  React.useEffect(() => {
    try {
      setHistory(JSON.parse(localStorage.getItem(historyKey) ?? "[]"));
    } catch {
      setHistory([]);
    }
  }, [historyKey]);

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    return stream.lines.filter(
      (l) =>
        l.seq > clearedAt &&
        (level === "all" || (level === "warn" ? ["WARN", "ERROR", "FATAL"].includes(l.level) : level === "error" ? ["ERROR", "FATAL"].includes(l.level) : level === "commands" ? l.stream === "command" : true)) &&
        (!q || l.text.toLowerCase().includes(q)),
    );
  }, [stream.lines, query, level, clearedAt]);

  const running = s.status === "running" || s.status === "starting";

  const send = () => {
    const cmd = input.trim();
    if (!cmd) return;
    rt.send({ type: "command", serverId: s.id, command: cmd });
    const next = [cmd, ...history.filter((h) => h !== cmd)].slice(0, 100);
    setHistory(next);
    try {
      localStorage.setItem(historyKey, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    setInput("");
    setHIndex(-1);
    setAutoScroll(true);
  };

  const text = () => filtered.map((l) => `${new Date(l.ts).toISOString()} ${l.text}`).join("\n");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter output…" className="h-8 pl-8 text-[13px]" aria-label="Filter console output" />
        </div>
        <NativeSelect value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 w-36 text-[13px]" aria-label="Log level">
          <option value="all">All levels</option>
          <option value="warn">Warnings & errors</option>
          <option value="error">Errors only</option>
          <option value="commands">Commands</option>
        </NativeSelect>
        <Tooltip content="Timestamps">
          <Button variant={showTime ? "secondary" : "ghost"} size="icon-sm" onClick={() => setShowTime((v) => !v)} aria-pressed={showTime} aria-label="Toggle timestamps">
            <Clock />
          </Button>
        </Tooltip>
        <Tooltip content={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}>
          <Button variant={autoScroll ? "secondary" : "ghost"} size="icon-sm" onClick={() => setAutoScroll((v) => !v)} aria-pressed={autoScroll} aria-label="Toggle auto-scroll">
            <ArrowDownToLine />
          </Button>
        </Tooltip>
        <Tooltip content="Copy visible output">
          <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={async () => (await navigator.clipboard.writeText(text()).catch(() => undefined), toast.success("Copied"))}>
            <Copy />
          </Button>
        </Tooltip>
        <Tooltip content="Download visible output">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Download"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `${s.name.replace(/[^A-Za-z0-9_-]/g, "_")}-console.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download />
          </Button>
        </Tooltip>
        <Tooltip content="Clear view (log files are kept)">
          <Button variant="ghost" size="icon-sm" aria-label="Clear" onClick={() => setClearedAt(stream.lines.at(-1)?.seq ?? 0)}>
            <Eraser />
          </Button>
        </Tooltip>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-console">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2 text-xs text-neutral-400">
          <StatusBadge status={s.status} />
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", conn === "open" ? "bg-emerald-400" : conn === "connecting" ? "bg-amber-300 animate-pulse" : "bg-red-400")} />
            {conn === "open" ? "Live" : conn === "connecting" ? "Connecting…" : "Disconnected — reconnecting"}
          </span>
          <span className="ml-auto tabular-nums">{filtered.length} lines</span>
        </div>
        <ConsoleLines lines={filtered} autoScroll={autoScroll} showTime={showTime} className="h-[min(60vh,560px)]" />
        <form
          className="flex items-center gap-2 border-t border-white/10 px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <span className="select-none font-mono text-sm text-neutral-500">&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const i = Math.min(history.length - 1, hIndex + 1);
                setHIndex(i);
                setInput(history[i]);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const i = hIndex - 1;
                setHIndex(Math.max(-1, i));
                setInput(i >= 0 ? history[i] : "");
              }
            }}
            disabled={!running || !canCommand || conn !== "open"}
            placeholder={!canCommand ? "You have read-only access" : running ? "Type a Minecraft command (e.g. list, say Hello, time set day)" : "Start the server to send commands"}
            className="h-8 flex-1 bg-transparent font-mono text-[13px] text-console-foreground outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed"
            aria-label="Minecraft command"
            autoComplete="off"
            spellCheck={false}
            maxLength={1000}
          />
          <Button type="submit" size="xs" variant="secondary" disabled={!running || !canCommand || !input.trim()} className="border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10">
            Send
          </Button>
        </form>
      </div>
      <p className="text-xs text-muted-foreground">Commands go to the Minecraft server console only — this is not a system shell. Commands are recorded in the audit log. ↑/↓ browse history.</p>
    </div>
  );
}
