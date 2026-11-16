"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { Badge, Button, Callout, ConfirmDialog, Panel, Progress, Section, Skeleton, Switch } from "@craftpanel/ui";
import { api, downloadUrl } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { formatBytes, formatDateTime } from "@/lib/format";

interface AppBackupInfo {
  filename: string;
  size: number;
  createdAt: number;
  servers: { total: number; withFiles: number } | null;
}
interface AppBackupList { backups: AppBackupInfo[]; progress: { running: boolean; message: string | null; percent: number | null; error: string | null } }

/** Settings → Backups: one file with the panel's database and settings, and optionally every server, for moving to another computer. */
export function AppBackups() {
  const [includeServers, setIncludeServers] = React.useState(true);
  const [deleting, setDeleting] = React.useState<AppBackupInfo | null>(null);
  const q = useQuery({
    queryKey: ["app-backups"],
    queryFn: () => api.get<AppBackupList>("/api/app-backups"),
    refetchInterval: (query) => (query.state.data?.progress.running ? 1000 : false),
  });
  const create = useAction(() => api.post("/api/app-backups", { includeServers }), { invalidate: [["app-backups"]] });
  const remove = useAction((filename: string) => api.del(`/api/app-backups/${filename}`), { success: "Backup deleted", invalidate: [["app-backups"]] });
  const progress = q.data?.progress;
  const running = !!progress?.running || create.isPending;
  return (
    <Section
      title="Application backup"
      description="One file with CraftPanel's database (accounts, settings, schedules, rules), its settings and, if you like, every server with its worlds. Use it to move CraftPanel to another computer or to start over after a disk failure."
    >
      <div className="space-y-4">
        <Callout variant="warning" title="Keep this file private">
          It contains password hashes, API keys and, with HTTPS configured, the certificate key. Store it like the data directory itself.
        </Callout>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={includeServers} onCheckedChange={setIncludeServers} disabled={running} aria-label="Include server files and worlds" />
            Include server files and worlds
          </label>
          <Button onClick={() => create.mutate()} loading={running}>Create backup</Button>
        </div>
        {running && (
          <div className="space-y-1.5" role="status">
            <Progress value={progress?.percent ?? null} />
            <p className="text-xs text-muted-foreground">{progress?.message ?? "Preparing"}</p>
          </div>
        )}
        {progress?.error && !running && <Callout variant="warning" title="The last backup failed">{progress.error}</Callout>}
        {q.isLoading ? <Skeleton className="h-20 rounded-lg" /> : q.data?.backups.length ? (
          <Panel className="divide-y divide-border">
            {q.data.backups.map((b) => (
              <div key={b.filename} className="flex flex-wrap items-center gap-3 p-4 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{b.filename}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(b.createdAt)} · {formatBytes(b.size)}</div>
                </div>
                {b.servers && (
                  <Badge variant="outline">{b.servers.withFiles === b.servers.total && b.servers.total > 0 ? `${b.servers.total} server${b.servers.total === 1 ? "" : "s"} with files` : b.servers.withFiles ? `${b.servers.withFiles} of ${b.servers.total} servers with files` : "Settings only"}</Badge>
                )}
                <Button variant="secondary" size="sm" onClick={() => downloadUrl(`/api/app-backups/${b.filename}/download`)}><Download /> Download</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(b)} aria-label={`Delete ${b.filename}`}><Trash2 /></Button>
              </div>
            ))}
          </Panel>
        ) : <p className="text-[13px] text-muted-foreground">No application backups yet.</p>}
        <div className="space-y-2 text-[13px] text-muted-foreground">
          <p className="font-medium text-foreground">Moving to another computer</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Install CraftPanel on the new computer, but don&apos;t create an account yet. Stop it (and its runtime service).</li>
            <li>Copy the file there and run, as the account CraftPanel runs under: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">node apps/api/dist/index.js import-backup &lt;file&gt;</code></li>
            <li>Start CraftPanel and sign in with your old account. Each server downloads its game files again and starts if it had automatic start.</li>
          </ol>
        </div>
      </div>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this application backup?" description="The file is permanently removed." destructive confirmLabel="Delete" onConfirm={() => remove.mutateAsync(deleting!.filename)} />
    </Section>
  );
}
