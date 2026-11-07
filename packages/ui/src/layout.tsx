import * as React from "react";
import { cn } from "./cn";

/** Page title block used at the top of every view. */
export function PageHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled group of content. Prefer sections with dividers over nested cards. */
export function Section({ title, description, actions, children, className }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-4", className)}>
      {(title || actions) && (
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-0.5">
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-surface", className)} {...props} />;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center", className)}>
      {icon && <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mx-auto max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Callout({ variant = "info", title, children, icon, className }: { variant?: "info" | "warning" | "danger" | "success"; title?: React.ReactNode; children?: React.ReactNode; icon?: React.ReactNode; className?: string }) {
  const styles = {
    info: "border-border bg-muted/50",
    warning: "border-warning/30 bg-warning/5",
    danger: "border-destructive/30 bg-destructive/5",
    success: "border-success/30 bg-success/5",
  }[variant];
  const iconColor = { info: "text-muted-foreground", warning: "text-warning", danger: "text-destructive", success: "text-success" }[variant];
  return (
    <div className={cn("flex gap-3 rounded-lg border px-4 py-3 text-[13px]", styles, className)}>
      {icon && <div className={cn("mt-0.5 shrink-0 [&_svg]:size-4", iconColor)}>{icon}</div>}
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className="text-muted-foreground [&_a]:underline [&_a]:underline-offset-2">{children}</div>}
      </div>
    </div>
  );
}

/** Label + control + help text, the standard form row. */
export function Field({ label, htmlFor, help, error, children, className, aside }: { label: React.ReactNode; htmlFor?: string; help?: React.ReactNode; error?: string | null; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function Stat({ label, value, sub, className }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="truncate text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
