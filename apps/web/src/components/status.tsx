import { Badge, cn } from "@craftpanel/ui";
import type { ServerStatus } from "@craftpanel/shared";

const META: Record<ServerStatus, { label: string; dot: string; variant: "success" | "warning" | "danger" | "default" | "info" }> = {
  running: { label: "Running", dot: "bg-success", variant: "success" },
  starting: { label: "Starting", dot: "bg-warning animate-pulse", variant: "warning" },
  stopping: { label: "Stopping", dot: "bg-warning animate-pulse", variant: "warning" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground/50", variant: "default" },
  crashed: { label: "Crashed", dot: "bg-destructive", variant: "danger" },
  error: { label: "Error", dot: "bg-destructive", variant: "danger" },
  installing: { label: "Installing", dot: "bg-accent animate-pulse", variant: "info" },
  orphaned: { label: "Detached", dot: "bg-warning", variant: "warning" },
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
