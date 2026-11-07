"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Archive, CheckCircle2, Download, History, MoreHorizontal, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  PageHeader,
  Panel,
  Progress,
  Skeleton,
} from "@craftpanel/ui";
import type { BackupInfo, ServerStatus } from "@craftpanel/shared";
import { api, downloadUrl, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction, useServers } from "@/lib/queries";
import { useRealtimeEvent } from "@/lib/realtime";
import { formatBytes, formatDateTime, timeAgo } from "@/lib/format";

const KIND_LABEL: Record<string, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  "pre-restore": "Before restore",
  "pre-update": "Before update",
  "pre-migration": "Before migration",
  "pre-delete": "Before delete",
};

export function BackupTable({ backups, loading, showServer, serverStatus }: { backups?: BackupInfo[]; loading: boolean; showServer?: boolean; serverStatus: Record<string, ServerStatus> }) {
  const [progress, setProgress] = React.useState<Record<string, { percent: number | null; message?: string; status: string }>>({});
  useRealtimeEvent((m) => {
    if (m.type === "backup") setProgress((p) => ({ ...p, [m.backupId]: { percent: m.percent ?? null, message: m.message, status: m.status } }));
  });
  const canRestore = useCan("backup.restore");
  const canDelete = useCan("backup.delete");
  const [restoring, setRestoring] = React.useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = React.useState<BackupInfo | null>(null);
  const restore = useAction((id: string) => api.post(`/api/backups/${id}/restore`), { success: "Backup restored", invalidate: [["backups"], ["worlds"], ["server"]] });
  const remove = useAction((id: string) => api.del(`/api/backups/${id}`), { success: "Backup deleted", invalidate: [["backups"]] });

  if (loading) return <Skeleton className="h-40 rounded-xl" />;
  if (!backups?.length) return <EmptyState icon={<Archive />} title="No backups yet" description="Create a backup manually or schedule automatic backups under Automation." />;

  return (
    <Panel className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {showServer && <th className="px-4 py-2.5 font-medium">Server</th>}
            <th className="px-4 py-2.5 font-medium">Created</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
            <th className="px-4 py-2.5 font-medium">Size</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="w-12" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {backups.map((b) => {
            const live = progress[b.id];
            const running = b.status === "running" || live?.status === "running" || live?.status === "restoring";
            return (
              <tr key={b.id}>
                {showServer && (
                  <td className="px-4 py-3">
                    <Link href={`/server/?id=${b.serverId}&tab=backups`} className="font-medium hover:underline">
                      {b.serverName ?? "Deleted server"}
                    </Link>
                  </td>
                )}
                <td className="px-4 py-3">
                  <p title={formatDateTime(b.createdAt)}>{timeAgo(b.createdAt)}</p>
                  {b.note && <p className="text-xs text-muted-foreground">{b.note}</p>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{KIND_LABEL[b.kind] ?? b.kind}</td>
                <td className="px-4 py-3 tabular-nums">{b.status === "completed" ? formatBytes(b.size) : "—"}</td>
                <td className="px-4 py-3">
                  {running ? (
                    <div className="w-44 space-y-1">
                      <Progress value={live?.percent ?? null} />
                      <p className="truncate text-xs text-muted-foreground">{live?.message ?? "Working…"}</p>
                    </div>
                  ) : b.status === "completed" ? (
                    <Badge variant="success">
                      <CheckCircle2 /> Complete
                    </Badge>
                  ) : b.status === "failed" ? (
                    <Badge variant="danger" title={b.error ?? undefined}>
                      Failed
                    </Badge>
                  ) : (
                    <Badge>{b.status}</Badge>
                  )}
                  {b.status === "failed" && b.error && <p className="mt-1 max-w-xs text-xs text-destructive">{b.error}</p>}
                </td>
                <td className="px-2 py-2 text-right">
                  {b.status === "completed" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Backup actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          onSelect={async () => {
                            const t = toast.loading("Verifying archive…");
                            try {
                              const r = await api.post<{ ok: boolean; entries: number; error?: string }>(`/api/backups/${b.id}/verify`);
                              if (r.ok) toast.success(`Backup is intact (${r.entries} entries, checksum verified)`, { id: t });
                              else toast.error(`Verification failed: ${r.error}`, { id: t });
                            } catch (err) {
                              toast.error(errorMessage(err), { id: t });
                            }
                          }}
                        >
                          <ShieldCheck /> Verify integrity
                        </DropdownMenuItem>
                        {canRestore && (
                          <>
                            <DropdownMenuItem onSelect={() => downloadUrl(`/api/backups/${b.id}/download`)}>
                              <Download /> Download
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setRestoring(b)}>
                              <History /> Restore…
                            </DropdownMenuItem>
                          </>
                        )}
                        {canDelete && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onSelect={() => setDeleting(b)}>
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => !o && setRestoring(null)}
        title="Restore this backup?"
        description={
          restoring && serverStatus[restoring.serverId] && !["stopped", "crashed", "error"].includes(serverStatus[restoring.serverId])
            ? "The server must be stopped before restoring. Stop it first, then try again."
            : `The server's worlds and configuration are replaced with the state from ${restoring ? formatDateTime(restoring.createdAt) : ""}. The archive is verified first, and a safety backup of the current state is created automatically.`
        }
        confirmLabel="Restore"
        destructive
        onConfirm={() => restore.mutateAsync(restoring!.id)}
      />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete backup?" description="The archive file is permanently removed." destructive confirmLabel="Delete" onConfirm={() => remove.mutateAsync(deleting!.id)} />
    </Panel>
  );
}

export function BackupsView() {
  const q = useQuery({ queryKey: ["backups", "all"], queryFn: () => api.get<BackupInfo[]>("/api/backups") });
  const servers = useServers();
  const status = Object.fromEntries((servers.data ?? []).map((s) => [s.id, s.status]));
  const total = q.data?.filter((b) => b.status === "completed").reduce((n, b) => n + b.size, 0) ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Backups" description={q.data ? `${q.data.length} backups · ${formatBytes(total)} total. Retention and destination are configured in Settings.` : " "} />
      <BackupTable backups={q.data} loading={q.isLoading} showServer serverStatus={status} />
    </div>
  );
}
