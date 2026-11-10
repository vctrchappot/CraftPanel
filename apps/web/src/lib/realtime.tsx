"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConsoleLine, InstallProgress, OnlinePlayer, ServerDetail, ServerMetrics, ServerSummary, WsClientMessage, WsServerMessage } from "@craftpanel/shared";
import { wsUrl } from "./api";

type Listener = (msg: WsServerMessage) => void;
export type ConnectionState = "connecting" | "open" | "closed";

/**
 * Single WebSocket per tab with exponential-backoff reconnection.
 * Subscriptions are reference counted and re-sent after reconnecting. The latest console lines, players and
 * metrics of each subscribed server are kept, so a second view of the same server starts with them too (the
 * server sends its replay only for the first subscription).
 */
class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Map<string, number>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  state: ConnectionState = "closed";
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private closeListeners = new Set<(code: number) => void>();
  private latest = new Map<string, { lines: ConsoleLine[]; players: OnlinePlayer[] | null; metrics: ServerMetrics | null }>();

  connect() {
    this.closedByUser = false;
    if (this.ws && this.ws.readyState <= 1) return;
    this.setState("connecting");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      // disconnect() was called while connecting (e.g. React StrictMode's double mount); a later connect() clears the flag again.
      if (this.closedByUser) return ws.close();
      this.retry = 0;
      this.setState("open");
      for (const id of this.subs.keys()) this.send({ type: "subscribe", serverId: id });
    };
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.remember(msg);
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.latest.clear();
      this.setState("closed");
      for (const l of this.closeListeners) l(ev.code);
      if (this.closedByUser || ev.code === 4001) return;
      // 4002: the user's access changed; reconnect right away to pick up the new one.
      const delay = ev.code === 4002 ? 200 : Math.min(15000, 500 * 2 ** this.retry++) + Math.random() * 300;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    // Closing a socket that is still connecting logs a browser warning; onopen closes it instead.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }
  onState(l: (s: ConnectionState) => void) {
    this.stateListeners.add(l);
    return () => void this.stateListeners.delete(l);
  }

  send(msg: WsClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  onClose(l: (code: number) => void) {
    this.closeListeners.add(l);
    return () => void this.closeListeners.delete(l);
  }
  on(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  /** What is known about a subscribed server so far. */
  snapshot(serverId: string) {
    return this.latest.get(serverId);
  }
  private remember(msg: WsServerMessage) {
    if (msg.type !== "console" && msg.type !== "players" && msg.type !== "metrics" && msg.type !== "status") return;
    if (!this.subs.has(msg.serverId)) return;
    const entry = this.latest.get(msg.serverId) ?? { lines: [], players: null, metrics: null };
    if (msg.type === "console") entry.lines = mergeLines(entry.lines, msg.lines, msg.replay);
    else if (msg.type === "players") entry.players = msg.players;
    else if (msg.type === "metrics") entry.metrics = msg.metrics;
    else if (msg.status !== "running") entry.metrics = null;
    this.latest.set(msg.serverId, entry);
  }
  subscribe(serverId: string) {
    const n = this.subs.get(serverId) ?? 0;
    this.subs.set(serverId, n + 1);
    if (n === 0) this.send({ type: "subscribe", serverId });
    return () => {
      const c = (this.subs.get(serverId) ?? 1) - 1;
      if (c <= 0) {
        this.subs.delete(serverId);
        this.latest.delete(serverId);
        this.send({ type: "unsubscribe", serverId });
      } else this.subs.set(serverId, c);
    };
  }
}

const RealtimeContext = React.createContext<RealtimeClient | null>(null);

export function RealtimeProvider({ children, enabled }: { children: React.ReactNode; enabled: boolean }) {
  const [client] = React.useState(() => new RealtimeClient());
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!enabled) return;
    client.connect();
    // Keep cached server lists fresh from pushed events instead of polling.
    const off = client.on((msg) => {
      if (msg.type === "status") {
        qc.setQueryData<ServerSummary[]>(["servers"], (prev) => prev?.map((s) => (s.id === msg.serverId ? { ...s, status: msg.status } : s)));
        void qc.invalidateQueries({ queryKey: ["server", msg.serverId] });
        void qc.invalidateQueries({ queryKey: ["servers"] });
      } else if (msg.type === "players") {
        qc.setQueryData<ServerSummary[]>(["servers"], (prev) => prev?.map((s) => (s.id === msg.serverId ? { ...s, playersOnline: msg.players.length } : s)));
      } else if (msg.type === "event") {
        void qc.invalidateQueries({ queryKey: ["activity"] });
        if (msg.event.serverId) void qc.invalidateQueries({ queryKey: ["overview", msg.event.serverId] });
      } else if (msg.type === "backup" && ["completed", "failed", "restored"].includes(msg.status)) {
        void qc.invalidateQueries({ queryKey: ["backups"] });
      } else if (msg.type === "install" && msg.progress.done) {
        void qc.invalidateQueries({ queryKey: ["servers"] });
        void qc.invalidateQueries({ queryKey: ["server", msg.progress.serverId] });
      }
    });
    // Signed out elsewhere (4001) or access changed (4002): reload what the user may see.
    const offClose = client.onClose((code) => {
      if (code === 4001 || code === 4002) void qc.invalidateQueries();
    });
    const offState = client.onState((state) => {
      if (state === "open") {
        void qc.invalidateQueries({ queryKey: ["servers"] });
        void qc.invalidateQueries({ queryKey: ["server"] });
      } else {
        qc.setQueryData<ServerSummary[]>(["servers"], (rows) => rows?.map((s) => ({ ...s, status: "unknown" })));
        qc.setQueriesData<ServerDetail>({ queryKey: ["server"] }, (s) => s ? { ...s, status: "unknown", players: [], playersOnline: 0, pid: null } : s);
      }
    });
    return () => {
      off();
      offClose();
      offState();
      client.disconnect();
    };
  }, [client, enabled, qc]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const c = React.useContext(RealtimeContext);
  if (!c) throw new Error("useRealtime outside RealtimeProvider");
  return c;
}

export function useConnectionState(): ConnectionState {
  const c = useRealtime();
  const [s, setS] = React.useState(c.state);
  React.useEffect(() => c.onState(setS), [c]);
  return s;
}

export function useRealtimeEvent(handler: Listener) {
  const c = useRealtime();
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => c.on((m) => ref.current(m)), [c]);
}

const MAX_LINES = 5000;

/** Appends lines newer than the last one held (a replay replaces them), keeping at most MAX_LINES. */
function mergeLines(prev: ConsoleLine[], lines: ConsoleLine[], replay?: boolean) {
  if (replay) return lines;
  const lastSeq = prev.length ? prev[prev.length - 1].seq : 0;
  const next = prev.concat(lines.filter((l) => l.seq > lastSeq));
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/** Console lines, metrics and players for one server (subscribes while mounted). */
export function useServerStream(serverId: string | null) {
  const c = useRealtime();
  const [lines, setLines] = React.useState<ConsoleLine[]>([]);
  const [metrics, setMetrics] = React.useState<ServerMetrics | null>(null);
  const [players, setPlayers] = React.useState<OnlinePlayer[] | null>(null);
  const [install, setInstall] = React.useState<InstallProgress | null>(null);

  React.useEffect(() => {
    if (!serverId) return;
    const seed = c.snapshot(serverId);
    setLines(seed?.lines ?? []);
    setMetrics(seed?.metrics ?? null);
    setPlayers(seed?.players ?? null);
    const off = c.on((msg) => {
      if (msg.type === "console" && msg.serverId === serverId) setLines((prev) => mergeLines(prev, msg.lines, msg.replay)); else if (msg.type === "metrics" && msg.serverId === serverId) setMetrics(msg.metrics);
      else if (msg.type === "players" && msg.serverId === serverId) setPlayers(msg.players);
      else if (msg.type === "install" && msg.progress.serverId === serverId) setInstall(msg.progress.done && !msg.progress.error ? null : msg.progress);
      else if (msg.type === "status" && msg.serverId === serverId && msg.status !== "running") setMetrics(null);
    });
    const unsub = c.subscribe(serverId);
    const offState = c.onState((state) => { if (state !== "open") { setMetrics(null); setPlayers(null); } });
    return () => {
      off();
      unsub();
      offState();
    };
  }, [c, serverId]);

  return { lines, setLines, metrics, players, install };
}
