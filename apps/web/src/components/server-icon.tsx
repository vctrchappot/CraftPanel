"use client";

import * as React from "react";
import { cn } from "@craftpanel/ui";
import type { ServerSummary } from "@craftpanel/shared";

/** URL of a server's icon; the version changes with the picture, so a new icon is fetched and an old one stays cached. */
export const iconUrl = (id: string, version: number | null): string | null => (version === null ? null : `/api/servers/${id}/icon?v=${version}`);

/**
 * The picture players see next to the server in Minecraft's list. A server without one gets its first letter on a
 * quiet tile, so lists keep one rhythm whether or not a server has an icon.
 */
export function ServerIcon({ server, size = 40, src, className }: { server: Pick<ServerSummary, "id" | "name" | "iconVersion">; size?: number; src?: string | null; className?: string }) {
  const url = src === undefined ? iconUrl(server.id, server.iconVersion) : src;
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const box = { width: size, height: size };
  if (!url || failed) {
    return (
      <span aria-hidden style={{ ...box, fontSize: size * 0.42 }} className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-md border border-border bg-muted font-display font-medium uppercase text-muted-foreground", className)}>
        {Array.from(server.name.trim())[0] ?? "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a 64 px file from the dashboard's own API
    <img src={url} alt="" style={box} onError={() => setFailed(true)} className={cn("shrink-0 rounded-md border border-border bg-muted", size >= 64 && "[image-rendering:pixelated]", className)} />
  );
}
