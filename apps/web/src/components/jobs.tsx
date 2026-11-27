"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { Badge, Button, Panel, Progress, Skeleton, cn } from "@craftpanel/ui";
import type { JobInfo, JobState } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, timeAgo } from "@/lib/format";
import { useServers } from "@/lib/queries";

/** Query key of a job list: every job the user may see, or one server's. Kept live by RealtimeProvider. */
export const jobsKey = (serverId?: string) => ["jobs", serverId || "all"] as const;

const STATE: Record<JobState, { icon: React.ReactNode; label: string; className: string }> = {
  running: { icon: <Loader2 className="animate-spin" />, label: "Running", className: "text-foreground" },
  succeeded: { icon: <CircleCheck />, label: "Done", className: "text-status-running" },
  failed: { icon: <CircleX />, label: "Failed", className: "text-status-crashed" },
  interrupted: { icon: <CircleAlert />, label: "Interrupted", className: "text-status-starting" },
};

function JobRow({ job, serverName }: { job: JobInfo; serverName?: string }) {
  const state = STATE[job.state];
  const took = job.finishedAt ? job.finishedAt - job.startedAt : null;
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-[13px]">
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", state.className)} aria-label={state.label} role="img">{state.icon}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="break-words font-medium">{job.title}</p>
          {job.attempt > 1 && <Badge variant="outline">Resumed after a restart</Badge>}
        </div>
        {job.state === "running" && (
          <div className="space-y-1.5">
            <p className="break-words text-muted-foreground">{job.stage ?? "Starting"}{job.percent !== null && <span className="tabular-nums"> · {job.percent}%</span>}</p>
            <Progress value={job.percent} />
          </div>
        )}
        {job.error && job.state !== "running" && <p className={cn("break-words", job.state === "failed" ? "text-status-crashed" : "text-status-starting")}>{job.error}</p>}
        {job.hint && job.state !== "running" && <p className="break-words text-muted-foreground">{job.hint}</p>}
        <p className="text-xs text-muted-foreground">
          {serverName && job.serverId && (
            <>
              <Link href={`/server/?id=${job.serverId}`} className="hover:text-foreground hover:underline">{serverName}</Link>
              {" · "}
            </>
          )}
          {job.actor && <>{job.actor} · </>}
          <span title={formatDateTime(job.startedAt)}>started {timeAgo(job.startedAt)}</span>
          {took !== null && job.state === "succeeded" && <> · took {formatDuration(Math.max(took, 1000))}</>}
        </p>
      </div>
    </li>
  );
}

/** Long operations (installs, backups, restores, application backups) with live progress and how they ended. */
export function JobList({ serverId, showServer }: { serverId?: string; showServer?: boolean }) {
  const [limit, setLimit] = React.useState(5);
  const servers = useServers();
  const q = useQuery({ queryKey: jobsKey(serverId), queryFn: () => api.get<JobInfo[]>(`/api/jobs?limit=50${serverId ? `&serverId=${serverId}` : ""}`) });
  const names = React.useMemo(() => new Map(servers.data?.map((s) => [s.id, s.name]) ?? []), [servers.data]);
  if (q.isLoading) return <Skeleton className="h-24 rounded-lg" />;
  const list = q.data ?? [];
  if (!list.length) return <Panel><p className="p-6 text-center text-[13px] text-muted-foreground">No installs, backups or restores yet.</p></Panel>;
  const running = list.filter((j) => j.state === "running").length;
  const shown = list.slice(0, Math.max(limit, running));
  return (
    <Panel>
      <ul className="divide-y divide-border">
        {shown.map((job) => <JobRow key={job.id} job={job} serverName={showServer ? (job.serverId ? names.get(job.serverId) : undefined) : undefined} />)}
      </ul>
      {list.length > shown.length && (
        <div className="border-t border-border p-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit(50)}>Show {list.length - shown.length} more</Button>
        </div>
      )}
    </Panel>
  );
}
