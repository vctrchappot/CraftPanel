"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConsoleLine, InstallProgress, OnlinePlayer, ServerMetrics, ServerSummary, WsClientMessage, WsServerMessage } from "@craftpanel/shared";
import { wsUrl } from "./api";

type Listener = (msg: WsServerMessage) => void;
export type ConnectionState = "connecting" | "open" | "closed";

/**
 * Single WebSocket per tab with exponential-backoff reconnection.
 * Subscriptions are reference counted and re-sent after reconnecting.
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
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.setState("closed");
      if (this.closedByUser || ev.code === 4001) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++) + Math.random() * 300;
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
  on(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  subscribe(serverId: string) {
    const n = this.subs.get(serverId) ?? 0;
    this.subs.set(serverId, n + 1);
    if (n === 0) this.send({ type: "subscribe", serverId });
    return () => {
      const c = (this.subs.get(serverId) ?? 1) - 1;
      if (c <= 0) {
        this.subs.delete(serverId);
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
      } else if (msg.type === "backup" && ["completed", "failed", "restored"].includes(msg.status)) {
        void qc.invalidateQueries({ queryKey: ["backups"] });
      } else if (msg.type === "install" && msg.progress.done) {
        void qc.invalidateQueries({ queryKey: ["servers"] });
        void qc.invalidateQueries({ queryKey: ["server", msg.progress.serverId] });
      }
    });
    return () => {
      off();
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

/** Console lines, metrics and players for one server (subscribes while mounted). */
export function useServerStream(serverId: string | null) {
  const c = useRealtime();
  const [lines, setLines] = React.useState<ConsoleLine[]>([]);
  const [metrics, setMetrics] = React.useState<ServerMetrics | null>(null);
  const [players, setPlayers] = React.useState<OnlinePlayer[] | null>(null);
  const [install, setInstall] = React.useState<InstallProgress | null>(null);

  React.useEffect(() => {
    if (!serverId) return;
    setLines([]);
    setMetrics(null);
    const off = c.on((msg) => {
      if (msg.type === "console" && msg.serverId === serverId) {
        setLines((prev) => {
          if (msg.replay) return msg.lines;
          const lastSeq = prev.length ? prev[prev.length - 1].seq : 0;
          const fresh = msg.lines.filter((l) => l.seq > lastSeq);
          const next = prev.concat(fresh);
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } else if (msg.type === "metrics" && msg.serverId === serverId) setMetrics(msg.metrics);
      else if (msg.type === "players" && msg.serverId === serverId) setPlayers(msg.players);
      else if (msg.type === "install" && msg.progress.serverId === serverId) setInstall(msg.progress.done && !msg.progress.error ? null : msg.progress);
      else if (msg.type === "status" && msg.serverId === serverId && msg.status !== "running") setMetrics(null);
    });
    const unsub = c.subscribe(serverId);
    return () => {
      off();
      unsub();
    };
  }, [c, serverId]);

  return { lines, setLines, metrics, players, install };
}
