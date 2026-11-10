"use client";

import * as React from "react";
import { cn } from "@craftpanel/ui";
import { motdColor, parseMotd } from "@craftpanel/shared";
import { ServerIcon } from "../server-icon";
import type { ServerSummary } from "@craftpanel/shared";

/** A message of the day as the game draws it: the sixteen legacy colours on the list's dark background. */
export function MotdText({ raw, className }: { raw: string; className?: string }) {
  const lines = parseMotd(raw);
  return (
    <div className={cn("font-mono text-[13px] leading-[1.35]", className)}>
      {lines.map((segments, i) => (
        <p key={i} className="min-h-[1.35em] whitespace-pre-wrap break-words" style={{ color: "#aaaaaa" }}>
          {segments.map((s, j) => (
            <span
              key={j}
              title={s.obfuscated ? "Obfuscated text shuffles in the game" : undefined}
              className={cn(s.bold && "font-bold", s.italic && "italic", s.obfuscated && "opacity-60 blur-[0.6px]")}
              style={{ color: motdColor(s.color)?.hex ?? "#aaaaaa", textDecoration: [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || undefined }}
            >
              {s.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** One entry of Minecraft's multiplayer list, so the icon and message can be judged the way players will see them. */
export function ServerListEntry({ server, motd, iconSrc, name }: { server: Pick<ServerSummary, "id" | "name" | "iconVersion" | "playersOnline" | "maxPlayers" | "status">; motd: string | null; iconSrc?: string | null; name?: string }) {
  const online = server.status === "running" ? server.playersOnline : 0;
  return (
    <div className="rounded-lg border border-border bg-console p-2" aria-label="Preview of the Minecraft server list">
      <div className="flex gap-3 rounded-md border border-console-foreground/25 p-2">
        <ServerIcon server={server} size={64} src={iconSrc} className="rounded-none border-0 bg-console-foreground/10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 font-mono text-[13px]">
            <span className="truncate text-console-foreground">{name ?? server.name}</span>
            <span className="shrink-0 tabular-nums text-console-muted">
              {online}/{server.maxPlayers}
            </span>
          </div>
          {motd === null ? <p className="font-mono text-[13px] text-console-muted">No message set</p> : <MotdText raw={motd} />}
        </div>
      </div>
    </div>
  );
}
