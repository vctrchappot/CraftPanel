"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpCircle, Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button, Callout, Dialog, DialogContent, DialogFooter, DialogHeader, Switch, cn } from "@craftpanel/ui";
import { api, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction, useServers } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";
import { CopyButton } from "./server/workspace";

export interface UpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  message: string;
  rolledBack: boolean;
  finishedAt: number;
}

export interface UpdateStatus {
  runtime?: { protocol: number; sha256: string } | null;
  interruption?: "none" | "required" | "unknown";
  affectedServers?: { id: string; name: string; autoStart: boolean }[];
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  notes: string | null;
  source: "github" | "folder";
  checkedAt: number | null;
  error: string | null;
  install: { method: "linux-service" | "windows" | "git" | "manual"; updateCommand: string | null };
  canInstall: boolean;
  lastResult: UpdateResult | null;
}

interface UpdateProgress {
  running: boolean;
  target: string | null;
  startedAt: number | null;
  steps: string[];
  log: string[];
  result: UpdateResult | null;
}

/** Only administrators see update information; the server caches GitHub's answer for hours. */
export function useUpdates() {
  const canConfigure = useCan("app.configure");
  return useQuery({ queryKey: ["updates"], queryFn: () => api.get<UpdateStatus>("/api/updates"), enabled: canConfigure, staleTime: 3600_000, refetchInterval: 6 * 3600_000 });
}

// ---- the running update, shared by the dialog that starts it and the overlay that follows it ----

interface Flow {
  from: string;
  target: string;
  startedAt: number;
  phase: "installing" | "restarting" | "done" | "failed" | "slow";
  steps: string[];
  log: string[];
  sawRestart: boolean;
  result: UpdateResult | null;
}

let flow: Flow | null = null;
const listeners = new Set<() => void>();
const setFlow = (next: Flow | null) => {
  flow = next;
  for (const l of listeners) l();
};
const useFlow = () =>
  React.useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => flow,
    () => null,
  );

// ---- sidebar notice and the update dialog ----------------------------------------------------

/** Small notice in the sidebar when a newer release exists; opens the update dialog. */
export function UpdateNotice() {
  const q = useUpdates();
  const [open, setOpen] = React.useState(false);
  if (!q.data?.available) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-brand/40 bg-brand/10 px-2.5 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUpCircle className="size-4 shrink-0 text-brand-text" />
        <span>
          CraftPanel <span className="font-medium">v{q.data.latest}</span> is available
        </span>
      </button>
      <UpdateDialog status={q.data} open={open} onOpenChange={setOpen} />
    </>
  );
}

const MANUAL_HINT: Record<UpdateStatus["install"]["method"], string> = {
  "linux-service": "Run this on the CraftPanel machine. Dashboard-only updates keep Minecraft running. A runtime change requires an explicit maintenance restart (--allow-runtime-restart).",
  windows: "Run this in PowerShell on the CraftPanel computer. Dashboard-only updates keep Minecraft running. A runtime change requires explicit maintenance approval (CRAFTPANEL_ALLOW_RUNTIME_RESTART=1).",
  git: "Run this in the CraftPanel folder, then restart CraftPanel.",
  manual: "Download the new release and replace the app folder, or reinstall with the one-line installer from the README. Your servers and settings live in the data directory and are kept.",
};

export function UpdateDialog({ status: initial, open, onOpenChange }: { status: UpdateStatus; open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = useQuery({ queryKey: ["update-preview"], queryFn: () => api.get<UpdateStatus>("/api/updates?refresh=1"), enabled: open, staleTime: 0 });
  const s = preview.data ?? initial;
  const servers = useServers();
  const running = s.affectedServers ?? (servers.data ?? []).filter((x) => ["running", "starting", "stopping", "orphaned"].includes(x.status));
  const interrupts = s.interruption !== "none";
  const start = useAction(() => api.post<UpdateProgress>("/api/updates/install", { approvedRuntime: interrupts ? s.runtime?.sha256 : undefined }), {
    onSuccess: (p) => {
      onOpenChange(false);
      setFlow({ from: s.current, target: p.target ?? s.latest ?? "", startedAt: p.startedAt ?? Date.now(), phase: "installing", steps: p.steps, log: p.log, sawRestart: false, result: null });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader
          title={`CraftPanel v${s.latest} is available`}
          description={
            <>
              You have v{s.current}
              {s.publishedAt && <> · released {formatDateTime(Date.parse(s.publishedAt))}</>}
              {s.source === "folder" && <> · from the local release folder</>}
            </>
          }
        />
        {s.notes ? (
          <div className="scrollbar-thin max-h-72 overflow-y-auto rounded-lg border border-border p-4">
            <ReleaseNotes markdown={s.notes} />
          </div>
        ) : (
          s.releaseUrl && (
            <a href={s.releaseUrl} target="_blank" rel="noreferrer" className="text-[13px] underline decoration-border underline-offset-2 hover:decoration-foreground">
              Read the release notes on GitHub
            </a>
          )
        )}
        {s.interruption === "none" && <Callout variant="info" title="Dashboard update">Minecraft servers and connected players keep running while the dashboard restarts.</Callout>}
        {s.interruption === "unknown" && <Callout variant="warning" title="Interruption could not be determined">Reconnect the runtime or use the manual installer to review this release. No automatic update is started.</Callout>}
        {interrupts && running.length > 0 && (
          <Callout variant="warning" icon={<AlertTriangle />} title={`${running.length} server${running.length === 1 ? " is" : "s are"} running`}>
            <p>This release changes the Minecraft runtime. These servers must save and stop; players will be disconnected. Startup time depends on their worlds and software.</p>
            <ul className="mt-1 space-y-0.5">
              {running.map((x) => (
                <li key={x.id}>
                  <span className="font-medium">{x.name}</span> {x.autoStart ? "starts again automatically" : "stays stopped (\"Start with CraftPanel\" is off)"}
                </li>
              ))}
            </ul>
          </Callout>
        )}
        {!s.canInstall && (
          <div className="space-y-2 text-[13px]">
            <p className="text-muted-foreground">{MANUAL_HINT[s.install.method]}</p>
            {s.install.updateCommand && <CommandBox command={s.install.updateCommand} />}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Later
          </Button>
          {s.canInstall && (
            <Button onClick={() => start.mutate()} loading={start.isPending} disabled={preview.isFetching || !!preview.error || s.interruption === "unknown"}>
              <ArrowUpCircle /> {interrupts ? "Stop affected servers and update" : "Update dashboard"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommandBox({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
      <span className="flex-1 break-all">{command}</span>
      <CopyButton value={command} />
    </div>
  );
}

// ---- progress across the restart ----------------------------------------------------------

const PHASES = [
  { id: "download", label: "Download and verify the release" },
  { id: "install", label: "Install the reviewed update" },
  { id: "restart", label: "Start the new version" },
  { id: "done", label: "Done" },
] as const;

function phaseIndex(f: Flow): number {
  if (f.phase === "done") return 4;
  if (f.phase === "restarting" || f.sawRestart) return 2;
  if (f.steps.some((s) => /^(Installing|Starting)/.test(s))) return 1;
  return 0;
}

/** Follows an update started from this browser: installer progress, the restart, then reloads into the new version. */
export function UpdateOverlay() {
  const f = useFlow();
  const qc = useQueryClient();
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    if (!f || f.phase === "done" || f.phase === "failed") return;
    let stop = false;
    const tick = async () => {
      if (stop || !flow) return;
      setNow(Date.now());
      try {
        const p = await api.get<UpdateProgress>("/api/updates/progress");
        const cur = flow;
        const finished = p.result && p.result.finishedAt >= cur.startedAt ? p.result : null;
        if (finished && !finished.ok) return setFlow({ ...cur, phase: "failed", result: finished, log: p.log.length ? p.log : cur.log });
        const { version } = await api.get<{ version: string }>("/api/updates/whats-new");
        if (version === cur.target) {
          setFlow({ ...cur, phase: "done", result: finished });
          void qc.invalidateQueries();
          setTimeout(() => location.reload(), 2500);
          return;
        }
        setFlow({ ...cur, phase: Date.now() - cur.startedAt > 15 * 60_000 ? "slow" : cur.sawRestart ? "restarting" : "installing", steps: p.steps.length ? p.steps : cur.steps, log: p.log.length ? p.log : cur.log });
      } catch {
        // CraftPanel is down while the installer swaps versions.
        if (flow) setFlow({ ...flow, phase: "restarting", sawRestart: true });
      }
    };
    const t = setInterval(tick, 1500);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [f?.phase === "done" || f?.phase === "failed" ? f.phase : f ? "active" : null, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!f) return null;
  const at = phaseIndex(f);
  const seconds = Math.max(0, Math.round((now - f.startedAt) / 1000));
  const closable = f.phase === "failed" || f.phase === "slow";
  return (
    <Dialog open onOpenChange={(o) => !o && closable && setFlow(null)}>
      <DialogContent hideClose={!closable} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => !closable && e.preventDefault()}>
        <DialogHeader
          title={f.phase === "done" ? `Updated to v${f.target}` : f.phase === "failed" ? "The update didn't work" : `Updating to v${f.target}`}
          description={
            f.phase === "done"
              ? "Reloading the dashboard with the new version…"
              : f.phase === "failed"
                ? f.result?.rolledBack
                  ? `v${f.from} is running again; nothing was lost.`
                  : "See the details below."
                : `v${f.from} → v${f.target} · ${seconds}s`
          }
        />
        {f.phase !== "failed" && (
          <ol className="space-y-2.5">
            {PHASES.map((p, i) => {
              const done = i < at || f.phase === "done";
              const active = i === at && f.phase !== "done";
              return (
                <li key={p.id} className={cn("flex items-center gap-3 text-[13px]", !done && !active && "text-muted-foreground")}>
                  <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", done ? "border-success bg-success text-white" : active ? "border-foreground" : "border-border")}>
                    {done ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : null}
                  </span>
                  <span>
                    {p.label}
                    {active && p.id === "restart" && <span className="block text-xs text-muted-foreground">The dashboard is unavailable for a moment.</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {f.phase === "failed" && (
          <Callout variant="danger" icon={<AlertTriangle />}>
            {f.result?.message}
          </Callout>
        )}
        {f.phase === "slow" && (
          <Callout variant="warning" icon={<AlertTriangle />}>
            This takes longer than expected. Check the CraftPanel machine, or reload this page in a moment.
          </Callout>
        )}
        {f.log.length > 0 && f.phase !== "done" && (
          <details className="text-xs" open={f.phase === "failed"}>
            <summary className="cursor-pointer text-muted-foreground">Installer output</summary>
            <pre className="scrollbar-thin mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">{f.log.join("\n")}</pre>
          </details>
        )}
        {closable && (
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFlow(null)}>
              Close
            </Button>
            {f.phase === "slow" && <Button onClick={() => location.reload()}>Reload</Button>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- what's new after an update ----------------------------------------------------------

const SEEN_KEY = "craftpanel.seenVersion";

/** Once per browser after CraftPanel was updated: the release notes of the new version. */
export function WhatsNew() {
  const q = useQuery({ queryKey: ["whats-new"], queryFn: () => api.get<{ version: string; notes: string | null }>("/api/updates/whats-new"), staleTime: Infinity });
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    // During an update this page still runs the old version; the reload shows the notes.
    if (!q.data || flow) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SEEN_KEY);
      localStorage.setItem(SEEN_KEY, q.data.version);
    } catch {
      return;
    }
    // First visit from this browser: nothing to compare with.
    if (seen && seen !== q.data.version && q.data.notes) setOpen(true);
  }, [q.data]);
  if (!q.data?.notes) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent wide>
        <DialogHeader
          title={
            <span className="flex items-center gap-2 font-serif text-lg font-normal">
              <Sparkles className="size-4 text-brand-text" /> What&apos;s new in CraftPanel v{q.data.version}
            </span>
          }
          description="CraftPanel was updated since your last visit."
        />
        <div className="scrollbar-thin max-h-[60vh] overflow-y-auto">
          <ReleaseNotes markdown={q.data.notes} />
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- release notes: the small Markdown subset of CHANGELOG.md and GitHub releases ------------

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={m.index} className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        <a key={m.index} href={href} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
          {label}
        </a>,
      );
    }
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocks: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={blocks.length} className="list-disc space-y-1 pl-5">
        {items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) {
      items.push(bullet[1]!);
      continue;
    }
    flush();
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (heading) blocks.push(<h4 key={blocks.length} className="pt-1 text-[13px] font-semibold">{inline(heading[1]!)}</h4>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-2 text-[13px] leading-relaxed">{blocks}</div>;
}

// ---- Settings → Security & about -------------------------------------------------------------

/** Version, update status, one-click update and the update-check switch. */
export function UpdateSection() {
  const q = useUpdates();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const refresh = useAction(() => api.get<UpdateStatus>("/api/updates?refresh=1"), {
    success: (s) => (s.error ? s.error : s.available ? `CraftPanel v${s.latest} is available` : "CraftPanel is up to date"),
    onSuccess: (s) => qc.setQueryData(["updates"], s),
  });
  const toggle = useAction((updateCheck: boolean) => api.put("/api/settings", { updateCheck }), { invalidate: [["updates"], ["app-settings"]] });
  const s = q.data;
  if (q.error) return <p className="text-[13px] text-destructive">{errorMessage(q.error)}</p>;
  if (!s) return null;
  const failed = s.lastResult && !s.lastResult.ok ? s.lastResult : null;
  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex items-start justify-between gap-6">
        <p className="text-muted-foreground">
          Look up the newest release {s.source === "folder" ? "in the local release folder" : "on GitHub"} every few hours and show a notice here and in the sidebar. Nothing about this install is sent. Updates are only
          installed when you click Update now.
        </p>
        <Switch checked={s.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Check for updates" />
      </div>
      {failed && (
        <Callout variant="danger" icon={<AlertTriangle />} title={`The last update${failed.to ? ` to v${failed.to}` : ""} failed (${formatDateTime(failed.finishedAt)})`}>
          {failed.message}
          {failed.rolledBack && " The previous version was restored."}
        </Callout>
      )}
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
            {s.available ? <span className="font-medium text-brand-text">Update available</span> : !s.error && s.latest && <span className="text-success">Up to date</span>}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
                Check now
              </Button>
              {s.available && (
                <Button size="sm" onClick={() => setOpen(true)}>
                  <ArrowUpCircle /> {s.canInstall ? "Update now" : "How to update"}
                </Button>
              )}
            </div>
          </div>
          {s.error && <p className="text-destructive">{s.error}</p>}
          {!s.error && !s.latest && <p className="text-muted-foreground">No release has been published yet.</p>}
          {!s.canInstall && s.install.updateCommand && !s.available && (
            <p className="text-xs text-muted-foreground">
              Update command: <code className="font-mono">{s.install.updateCommand}</code>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {s.releaseUrl && (
              <a href={s.releaseUrl} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                {s.available ? "What's new" : "Releases"}
              </a>
            )}
            {s.releaseUrl && s.checkedAt && " · "}
            {s.checkedAt && <>checked {formatDateTime(s.checkedAt)}</>}
          </p>
        </div>
      )}
      {s.available && <UpdateDialog status={s} open={open} onOpenChange={setOpen} />}
      <RuntimeMaintenance />
    </div>
  );
}

function RuntimeMaintenance() {
  const [open, setOpen] = React.useState(false);
  const servers = useServers();
  const active = (servers.data ?? []).filter((s) => ["running", "starting", "stopping"].includes(s.status));
  const unknown = (servers.data ?? []).some((s) => s.status === "unknown");
  const stop = useAction(async () => {
    const response = await api.post<{ results: { id: string; stopped: boolean }[] }>("/api/system/stop-all");
    if (response.results.some((r) => !r.stopped)) throw new Error("Some servers did not stop in time. Check their consoles before maintenance.");
    return response;
  }, { success: "All Minecraft servers stopped", invalidate: [["servers"], ["server"]], onSuccess: () => setOpen(false) });
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={unknown || !active.length}>Stop all servers for maintenance</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader title="Stop all Minecraft servers?" description="The runtime saves and stops each server. Connected players will be disconnected. Auto-start settings remain in effect for the next host boot." />
          <ul>{active.map((s) => <li key={s.id}>{s.name}</li>)}</ul>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => stop.mutate()} loading={stop.isPending} disabled={unknown}>Save and stop all servers</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
