"use client";

import * as React from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { Button, EmptyState, NativeSelect, PageHeader, Panel, Skeleton, cn } from "@craftpanel/ui";
import type { ActivityEvent } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useServers } from "@/lib/queries";

export function EventList({ events, showServer, compact }: { events: ActivityEvent[]; showServer?: boolean; compact?: boolean }) {
  if (!events.length) return <p className="p-6 text-center text-[13px] text-muted-foreground">No activity yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className={cn("flex items-start gap-3 text-[13px]", compact ? "px-4 py-2.5" : "px-4 py-3")}>
          <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-warning" : "text-muted-foreground")}>
            {e.level === "error" ? <CircleAlert /> : e.level === "warn" ? <AlertTriangle /> : <Info />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words">{e.message}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {showServer && e.serverName && (
                <>
                  <Link href={`/server/?id=${e.serverId}`} className="hover:text-foreground hover:underline">
                    {e.serverName}
                  </Link>
                  {" · "}
                </>
              )}
              {e.actor && <>{e.actor} · </>}
              <span title={formatDateTime(e.createdAt)}>{timeAgo(e.createdAt)}</span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityView() {
  const servers = useServers();
  const [serverId, setServerId] = React.useState("");
  const q = useInfiniteQuery({
    queryKey: ["activity", "all", serverId],
    queryFn: ({ pageParam }) => api.get<ActivityEvent[]>(`/api/activity?limit=50${serverId ? `&serverId=${serverId}` : ""}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].id : undefined),
  });
  const events = q.data?.pages.flat() ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Server lifecycle events, backups, configuration changes and scheduled tasks."
        actions={
          <NativeSelect value={serverId} onChange={(e) => setServerId(e.target.value)} className="w-48" aria-label="Filter by server">
            <option value="">All servers</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : events.length ? (
        <Panel>
          <EventList events={events} showServer={!serverId} />
          {q.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </Panel>
      ) : (
        <EmptyState title="No activity yet" description="Events appear here as you create, start and manage servers." />
      )}
    </div>
  );
}
