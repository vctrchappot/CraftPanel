"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Boxes, Plus } from "lucide-react";
import { Button, EmptyState, PageHeader, Panel, Skeleton } from "@craftpanel/ui";
import { softwareLabel } from "@craftpanel/shared";
import { useCan } from "@/lib/auth";
import { useServersActiveFirst } from "@/lib/queries";
import { formatDuration } from "@/lib/format";
import { StatusBadge } from "./status";

export function ServersView() {
  const servers = useServersActiveFirst();
  const router = useRouter();
  const canCreate = useCan("server.create");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="Every Minecraft server managed by this CraftPanel installation."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/servers/new/">
                <Plus /> New server
              </Link>
            </Button>
          )
        }
      />
      {servers.isLoading ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : !servers.data?.length ? (
        <EmptyState
          icon={<Boxes />}
          title="No servers yet"
          description="Create a Vanilla or Paper server in a few steps."
          action={
            canCreate && (
              <Button asChild>
                <Link href="/servers/new/">
                  <Plus /> Create server
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Software</th>
                <th className="px-4 py-2.5 font-medium">Players</th>
                <th className="px-4 py-2.5 font-medium">Port</th>
                <th className="px-4 py-2.5 font-medium">Memory</th>
                <th className="px-4 py-2.5 font-medium">Uptime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {servers.data.map((s) => (
                <tr
                  key={s.id}
                  tabIndex={0}
                  onClick={() => router.push(`/server/?id=${s.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && router.push(`/server/?id=${s.id}`)}
                  className="cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium">{s.name}</p>
                    {s.description && <p className="max-w-xs truncate text-xs text-muted-foreground">{s.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {softwareLabel(s.software)} {s.mcVersion}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{s.status === "running" ? `${s.playersOnline} / ${s.maxPlayers}` : "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{s.port}</td>
                  <td className="px-4 py-3 tabular-nums">{(s.memoryMb / 1024).toFixed(1)} GB</td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{s.startedAt ? formatDuration(Date.now() - s.startedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
