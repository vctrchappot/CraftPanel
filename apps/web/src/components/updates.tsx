"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { Button, Switch } from "@craftpanel/ui";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";
import { CopyButton } from "./server/workspace";

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: number | null;
  error: string | null;
  install: { method: "linux-service" | "windows" | "git" | "manual"; updateCommand: string | null };
}

/** Only administrators see update information; the server caches GitHub's answer for hours. */
export function useUpdates() {
  const canConfigure = useCan("app.configure");
  return useQuery({ queryKey: ["updates"], queryFn: () => api.get<UpdateStatus>("/api/updates"), enabled: canConfigure, staleTime: 3600_000, refetchInterval: 6 * 3600_000 });
}

/** Small notice in the sidebar when a newer release exists. */
export function UpdateNotice() {
  const q = useUpdates();
  if (!q.data?.available) return null;
  return (
    <Link
      href="/settings/?tab=about"
      className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2 text-[12px] text-foreground transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUpCircle className="size-4 shrink-0 text-accent" />
      <span>
        CraftPanel <span className="font-medium">v{q.data.latest}</span> is available
      </span>
    </Link>
  );
}

const MANUAL_HINT: Record<UpdateStatus["install"]["method"], string> = {
  "linux-service": "Run this on the machine where CraftPanel is installed. Running servers are stopped gracefully and CraftPanel restarts with the new version.",
  windows: "Run this in PowerShell on the computer where CraftPanel is installed. Running servers are stopped gracefully and CraftPanel restarts with the new version.",
  git: "Run this in the CraftPanel folder, then restart CraftPanel.",
  manual: "Download the new release and replace the app folder, or reinstall with the one-line installer from the README. Your servers and settings live in the data directory and are kept.",
};

/** Version, update status and the update-check switch (Settings → Security & about). */
export function UpdateSection() {
  const q = useUpdates();
  const qc = useQueryClient();
  const refresh = useAction(() => api.get<UpdateStatus>("/api/updates?refresh=1"), {
    success: (s) => (s.error ? s.error : s.available ? `CraftPanel v${s.latest} is available` : "CraftPanel is up to date"),
    onSuccess: (s) => qc.setQueryData(["updates"], s),
  });
  const toggle = useAction((updateCheck: boolean) => api.put("/api/settings", { updateCheck }), { invalidate: [["updates"], ["app-settings"]] });
  const s = q.data;
  if (!s) return null;
  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex items-start justify-between gap-6">
        <p className="text-muted-foreground">
          Look up the newest release on GitHub every few hours and show a notice here and in the sidebar. Nothing about this install is sent; CraftPanel never updates itself.
        </p>
        <Switch checked={s.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Check for updates" />
      </div>
      {s.enabled && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Installed <span className="font-medium">v{s.current}</span>
              {s.latest && (
                <>
                  {" "}
                  · latest <span className="font-medium">v{s.latest}</span>
                </>
              )}
            </span>
            {s.available ? <span className="font-medium text-accent">Update available</span> : !s.error && s.latest && <span className="text-success">Up to date</span>}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
              Check now
            </Button>
          </div>
          {s.error && <p className="text-destructive">{s.error}</p>}
          {!s.error && !s.latest && <p className="text-muted-foreground">No release has been published yet.</p>}
          {s.available && (
            <div className="space-y-2">
              <p className="text-muted-foreground">{MANUAL_HINT[s.install.method]}</p>
              {s.install.updateCommand && (
                <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  <span className="flex-1 break-all">{s.install.updateCommand}</span>
                  <CopyButton value={s.install.updateCommand} />
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {s.releaseUrl && (
              <a href={s.releaseUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {s.available ? "What's new" : "Releases"}
              </a>
            )}
            {s.checkedAt && <> · checked {formatDateTime(s.checkedAt)}</>}
          </p>
        </div>
      )}
    </div>
  );
}
