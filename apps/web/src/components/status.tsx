import { Badge, cn } from "@craftpanel/ui";
import type { ServerStatus } from "@craftpanel/shared";

const META: Record<ServerStatus, { label: string; dot: string; variant: "success" | "warning" | "danger" | "default" | "info" }> = {
  unknown: { label: "Connection lost", dot: "bg-status-stopped", variant: "warning" },
  running: { label: "Running", dot: "bg-status-running", variant: "success" },
  starting: { label: "Starting", dot: "bg-status-starting animate-pulse", variant: "warning" },
  stopping: { label: "Stopping", dot: "bg-status-starting animate-pulse", variant: "warning" },
  stopped: { label: "Stopped", dot: "bg-status-stopped", variant: "default" },
  crashed: { label: "Crashed", dot: "bg-status-crashed", variant: "danger" },
  error: { label: "Error", dot: "bg-status-crashed", variant: "danger" },
  installing: { label: "Installing", dot: "bg-status-starting animate-pulse", variant: "info" },
  orphaned: { label: "Detached", dot: "bg-status-starting", variant: "warning" },
};

export function StatusDot({ status, className }: { status: ServerStatus; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", META[status].dot, className)} aria-hidden />;
}

export function StatusBadge({ status }: { status: ServerStatus }) {
  const m = META[status];
  return (
    <Badge variant={m.variant}>
      <StatusDot status={status} className="size-1.5" />
      {m.label}
    </Badge>
  );
}

export const statusLabel = (s: ServerStatus) => META[s].label;

/** Placeholder shown for metrics the server cannot provide. Never fabricate values. */
export function Unavailable({ reason }: { reason?: string }) {
  return (
    <span className="text-muted-foreground" title={reason ?? "Not available"}>
      —
    </span>
  );
}
