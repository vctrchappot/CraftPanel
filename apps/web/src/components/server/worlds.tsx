"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileArchive, Globe2, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Callout, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, EmptyState, Field, Input, NativeSelect, Panel, Progress, Section, Skeleton, Switch, cn } from "@craftpanel/ui";
import { planWorldImport, readZipEntryNames, suggestWorldName, uniqueWorldName, type ServerDetail, type WorldImportPlan, type WorldInfo } from "@craftpanel/shared";
import { api, downloadUrl, errorMessage, upload } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatBytes, timeAgo } from "@/lib/format";

export function WorldsTab({ server: s }: { server: ServerDetail }) {
  const key = ["worlds", s.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<WorldInfo[]>(`/api/servers/${s.id}/worlds`) });
  const canManage = useCan("worlds.manage");
  const running = s.status === "running" || s.status === "starting";
  const inv = [key, ["server", s.id]];
  const select = useAction((name: string) => api.post(`/api/servers/${s.id}/worlds/${encodeURIComponent(name)}/select`), { success: "Active world changed. Restart to load it.", invalidate: inv });
  const del = useAction((name: string) => api.del(`/api/servers/${s.id}/worlds/${encodeURIComponent(name)}`), { success: "World deleted (a backup was taken first)", invalidate: [...inv, ["backups"]] });
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [dropped, setDropped] = React.useState<File | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const openImport = (file: File | null) => {
    setDropped(file);
    setImporting(true);
  };
  const exportWorld = (name: string) => {
    toast.info(`Packing "${name}": the download starts as soon as the archive is ready`);
    downloadUrl(`/api/servers/${s.id}/worlds/${encodeURIComponent(name)}/export`);
  };
  // Events from the open dialog bubble up through its portal; the dialog has its own drop target.
  const isFileDrag = (e: React.DragEvent) => !importing && e.dataTransfer.types.includes("Files");

  return (
    <div
      className="relative space-y-6"
      onDragOver={(e) => {
        if (!canManage || !isFileDrag(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (!canManage || !file || importing) return;
        e.preventDefault();
        openImport(file);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm font-medium">
          <Upload className="mr-2 size-4" /> Drop the world .zip to import it
        </div>
      )}
      <Section
        title="Worlds"
        description="The active world is loaded when the server starts. Paper's Nether and End folders are grouped with their overworld. Drop a world .zip anywhere on this page to import it."
        actions={
          canManage && (
            <>
              <Button size="sm" variant="secondary" onClick={() => openImport(null)}>
                <Upload /> Import
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New world
              </Button>
            </>
          )
        }
      >
        {q.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : !q.data?.length ? (
          <EmptyState
            icon={<Globe2 />}
            title="No worlds yet"
            description="The world is generated the first time the server starts, or bring your own."
            action={
              canManage && (
                <Button size="sm" variant="secondary" onClick={() => openImport(null)}>
                  <Upload /> Import a world
                </Button>
              )
            }
          />
        ) : (
          <Panel>
            <ul className="divide-y divide-border">
              {q.data.map((w) => (
                <li key={w.name} className="flex flex-wrap items-center gap-4 px-4 py-3.5 text-[13px]">
                  <Globe2 className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      {w.name}
                      {w.active && (
                        <Badge variant="success">
                          <CheckCircle2 /> Active
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {w.modifiedAt ? `${formatBytes(w.size)} · ${w.dimensions.join(", ")} · modified ${timeAgo(w.modifiedAt)}` : "Not generated yet — created on next start"}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex gap-1">
                      {!w.active && (
                        <Button size="xs" variant="secondary" onClick={() => select.mutate(w.name)}>
                          Make active
                        </Button>
                      )}
                      {w.modifiedAt > 0 && (
                        <Button size="xs" variant="ghost" onClick={() => exportWorld(w.name)}>
                          <Download /> Export
                        </Button>
                      )}
                      {!w.active && (
                        <Button size="xs" variant="destructive-ghost" onClick={() => setDeleting(w.name)} disabled={running}>
                          <Trash2 /> Delete
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {running && <p className="text-xs text-muted-foreground">Stop the server to delete worlds. Exporting a running world saves it first, so the archive is consistent.</p>}
      </Section>

      <CreateWorldDialog open={creating} onOpenChange={setCreating} serverId={s.id} />
      <ImportWorldDialog open={importing} onOpenChange={setImporting} serverId={s.id} initialFile={dropped} existing={(q.data ?? []).map((w) => w.name)} running={running} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete world "${deleting}"?`}
        description="The world folder (and its Nether/End folders) are permanently removed. CraftPanel creates a backup of the server first."
        confirmLabel="Delete world"
        destructive
        confirmText={deleting ?? ""}
        onConfirm={() => del.mutateAsync(deleting!)}
      />
    </div>
  );
}

function CreateWorldDialog({ open, onOpenChange, serverId }: { open: boolean; onOpenChange: (o: boolean) => void; serverId: string }) {
  const [name, setName] = React.useState("");
  const [seed, setSeed] = React.useState("");
  const [type, setType] = React.useState("minecraft:normal");
  const create = useAction(() => api.post(`/api/servers/${serverId}/worlds`, { name, seed, levelType: type, activate: true }), {
    success: "World will be generated on the next start",
    invalidate: [["worlds", serverId], ["server", serverId]],
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="New world" description="Minecraft generates the world when the server next starts. Your existing worlds are kept." />
        <Field label="Name" htmlFor="wname">
          <Input id="wname" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={64} />
        </Field>
        <Field label="Seed" htmlFor="wseed" help="Leave empty for random.">
          <Input id="wseed" value={seed} onChange={(e) => setSeed(e.target.value)} maxLength={64} />
        </Field>
        <Field label="Type" htmlFor="wtype">
          <NativeSelect id="wtype" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="minecraft:normal">Default</option>
            <option value="minecraft:flat">Superflat</option>
            <option value="minecraft:large_biomes">Large biomes</option>
            <option value="minecraft:amplified">Amplified</option>
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
            Create & activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Peek = { state: "idle" } | { state: "reading" } | { state: "ok"; plan: WorldImportPlan } | { state: "invalid"; message: string; hint?: string } | { state: "unknown" };

const DIMENSION_LABEL = { overworld: "Overworld", nether: "Nether", the_end: "The End" } as const;

function ImportWorldDialog({ open, onOpenChange, serverId, initialFile, existing, running }: { open: boolean; onOpenChange: (o: boolean) => void; serverId: string; initialFile: File | null; existing: string[]; running: boolean }) {
  const qc = useQueryClient();
  const [file, setFile] = React.useState<File | null>(null);
  const [peek, setPeek] = React.useState<Peek>({ state: "idle" });
  const [name, setName] = React.useState("");
  const [activate, setActivate] = React.useState(true);
  const [pct, setPct] = React.useState<number | null>(null);
  const [over, setOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const existingRef = React.useRef(existing);
  existingRef.current = existing;

  const choose = React.useCallback(async (f: File | null) => {
    setFile(f);
    setPeek(f ? { state: "reading" } : { state: "idle" });
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      setPeek({ state: "invalid", message: "Worlds are imported from a .zip archive", hint: "Zip the world folder (the one with level.dat in it) and choose the zip." });
      return;
    }
    const names = await readZipEntryNames(f);
    if (!names) {
      setPeek({ state: "unknown" });
      setName(uniqueWorldName(suggestWorldName(f.name), existingRef.current));
      return;
    }
    const result = planWorldImport(names);
    if (!result.ok) return setPeek({ state: "invalid", message: result.message, hint: result.hint });
    setPeek({ state: "ok", plan: result.plan });
    setName(uniqueWorldName(suggestWorldName(result.plan.sourceName || f.name), existingRef.current));
  }, []);

  // Start fresh each time the dialog opens, with the file that was dropped on the tab if there is one.
  React.useEffect(() => {
    if (!open) return;
    setActivate(true);
    setPct(null);
    setName("");
    void choose(initialFile);
  }, [open, initialFile, choose]);

  const taken = existing.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? null : taken ? "A world with this name already exists on this server" : !/^[A-Za-z0-9 _.-]+$/.test(name.trim()) ? "Use letters, digits, spaces, '.', '_' and '-'" : null;
  const ready = !!file && (peek.state === "ok" || peek.state === "unknown") && !!name.trim() && !nameError;
  const busy = pct !== null;

  const submit = async () => {
    setPct(0);
    try {
      await upload(`/api/servers/${serverId}/worlds/import?name=${encodeURIComponent(name.trim())}&activate=${activate}`, file!, setPct);
      toast.success(activate ? (running ? "World imported and set active. Restart the server to load it." : "World imported and set active") : "World imported");
      await Promise.all([qc.invalidateQueries({ queryKey: ["worlds", serverId] }), qc.invalidateQueries({ queryKey: ["server", serverId] })]);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPct(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader title="Import a world" description="From singleplayer, another host or CraftPanel's own export. Nothing existing is overwritten." />
        {!file ? (
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(false);
              void choose(e.dataTransfer.files[0] ?? null);
            }}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              over ? "border-primary bg-muted" : "border-border hover:bg-muted/50",
            )}
          >
            <Upload className="size-5 text-muted-foreground" />
            <span className="text-sm font-medium">Drop a world .zip here or click to choose</span>
            <span className="text-xs text-muted-foreground">Zip the world's folder. In singleplayer it is under .minecraft/saves.</span>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]">
            <FileArchive className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
            </div>
            {!busy && (
              <Button size="xs" variant="ghost" onClick={() => input.current?.click()}>
                Change
              </Button>
            )}
          </div>
        )}
        <input ref={input} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => void choose(e.target.files?.[0] ?? null)} />

        {peek.state === "reading" && <Skeleton className="h-10 rounded-lg" />}
        {peek.state === "invalid" && (
          <Callout variant="danger" title={peek.message}>
            {peek.hint}
          </Callout>
        )}
        {peek.state === "ok" && (
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Found a world with</span>
            {peek.plan.dimensions.map((d) => (
              <Badge key={d}>{DIMENSION_LABEL[d]}</Badge>
            ))}
          </div>
        )}

        {(peek.state === "ok" || peek.state === "unknown") && (
          <>
            <Field label="World name" htmlFor="winame" error={nameError} help="The folder name on the server.">
              <Input id="winame" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} disabled={busy} />
            </Field>
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-[13px]">
              <span>
                <span className="block font-medium">Make it the active world</span>
                <span className="block text-xs text-muted-foreground">{running ? "The server loads it on its next start." : "The server loads it when it starts."}</span>
              </span>
              <Switch checked={activate} onCheckedChange={setActivate} disabled={busy} aria-label="Make it the active world" />
            </label>
            {peek.state === "unknown" && <Callout>CraftPanel could not preview this archive. The server checks it and tells you if it holds no world.</Callout>}
          </>
        )}

        {pct !== null && (
          <div className="space-y-1.5">
            <Progress value={pct} />
            <p className="text-xs text-muted-foreground">{pct < 100 ? `Uploading… ${pct}%` : "Unpacking on the server…"}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!ready} loading={busy} onClick={() => void submit()}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
