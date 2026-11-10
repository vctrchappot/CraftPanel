"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Gauge, Loader2, MoreHorizontal, Play, RotateCw, Settings, Square, SquareTerminal } from "lucide-react";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@craftpanel/ui";
import type { ServerSummary } from "@craftpanel/shared";
import { useCan } from "@/lib/auth";
import { useServerLifecycle } from "@/lib/queries";
import { ServerIcon } from "./server-icon";
import { StatusDot, statusLabel } from "./status";

const iconButton =
  "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none [&_svg]:size-3.5";

/** One line under the name: what the server is doing right now, in words. */
function subline(s: ServerSummary): { text: string; warn?: boolean } {
  if (s.status === "running") {
    if (s.restartRequired) return { text: "Restart needed", warn: true };
    return { text: s.playersOnline === 1 ? "1 player online" : `${s.playersOnline} players online` };
  }
  if (s.installState !== "installed" && s.status === "stopped") return { text: s.installState === "failed" ? "Install failed" : "Not installed", warn: s.installState === "failed" };
  return { text: statusLabel(s.status) };
}

/**
 * A server in the sidebar: icon with its status, name, a line of live detail, and quick actions that appear on hover
 * or keyboard focus (always on touch screens). Starting and stopping never needs a trip to the server page.
 */
export function SidebarServer({ server: s, active }: { server: ServerSummary; active: boolean }) {
  const router = useRouter();
  const life = useServerLifecycle(s.id);
  const canControl = useCan("server.control");
  const startable = ["stopped", "crashed", "error"].includes(s.status) && s.installState === "installed" && s.eulaAccepted;
  const stoppable = s.status === "running" || s.status === "starting" || s.status === "orphaned";
  const busy = life.start.isPending || life.stop.isPending || life.restart.isPending || s.status === "stopping";
  const line = subline(s);
  const open = (tab: string) => router.push(`/server/?id=${s.id}&tab=${tab}`);

  return (
    <div className={cn("group relative rounded-md transition-colors", active ? "bg-muted" : "hover:bg-muted/60")}>
      <Link
        href={`/server/?id=${s.id}`}
        aria-current={active ? "page" : undefined}
        className="flex h-11 items-center gap-2.5 rounded-md pl-2 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative shrink-0">
          <ServerIcon server={s} size={26} className="rounded" />
          <StatusDot status={s.status} className="absolute -bottom-0.5 -right-0.5 size-2.5 ring-2 ring-background transition-shadow group-hover:ring-muted" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px] leading-4", active ? "font-medium text-foreground" : "text-foreground/85 group-hover:text-foreground")}>{s.name}</span>
          <span className={cn("block truncate text-[11px] leading-4", line.warn ? "text-warning" : "text-muted-foreground")}>{line.text}</span>
        </span>
      </Link>
      <div
        className={cn(
          "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-muted/95 p-0.5 opacity-0 shadow-xs ring-1 ring-border transition-opacity",
          "group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        {canControl && busy && (
          <span className={iconButton} aria-label="Working">
            <Loader2 className="animate-spin" />
          </span>
        )}
        {canControl && !busy && startable && (
          <button className={iconButton} title="Start" aria-label={`Start ${s.name}`} onClick={() => life.start.mutate()}>
            <Play />
          </button>
        )}
        {canControl && !busy && stoppable && (
          <button className={iconButton} title="Stop" aria-label={`Stop ${s.name}`} onClick={() => life.stop.mutate()}>
            <Square />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={iconButton} title="More" aria-label={`More actions for ${s.name}`}>
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {canControl && s.status === "running" && (
              <>
                <DropdownMenuItem onSelect={() => life.restart.mutate()} disabled={busy}>
                  <RotateCw /> Restart
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => open("console")}>
              <SquareTerminal /> Console
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("performance")}>
              <Gauge /> Performance
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("settings")}>
              <Settings /> Settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
