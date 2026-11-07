"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Download, Globe2, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Callout, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, EmptyState, Field, Input, NativeSelect, Panel, Progress, Section, Skeleton } from "@craftpanel/ui";
import type { ServerDetail, WorldInfo } from "@craftpanel/shared";
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

  return (
    <div className="space-y-6">
      <Section
        title="Worlds"
        description="The active world is loaded when the server starts. Paper's Nether and End folders are grouped with their overworld."
        actions={
          canManage && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>
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
          <EmptyState icon={<Globe2 />} title="No worlds yet" description="The world is generated the first time the server starts." />
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
                        <Button size="xs" variant="ghost" onClick={() => downloadUrl(`/api/servers/${s.id}/worlds/${encodeURIComponent(w.name)}/export`)}>
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
        {running && <p className="text-xs text-muted-foreground">Stop the server to delete worlds. Exporting a running world forces a save first.</p>}
      </Section>

      <CreateWorldDialog open={creating} onOpenChange={setCreating} serverId={s.id} />
      <ImportWorldDialog open={importing} onOpenChange={setImporting} serverId={s.id} />
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

function ImportWorldDialog({ open, onOpenChange, serverId }: { open: boolean; onOpenChange: (o: boolean) => void; serverId: string }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState("");
  const [pct, setPct] = React.useState<number | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Import world" description="Upload a .zip containing a Minecraft world (level.dat at the top level or inside one folder)." />
        <Field label="Archive" htmlFor="wfile">
          <Input
            id="wfile"
            type="file"
            accept=".zip"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !name) setName(f.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9 _.-]/g, "_"));
            }}
          />
        </Field>
        <Field label="World name" htmlFor="winame">
          <Input id="winame" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Callout>Archives are extracted safely: paths outside the world folder and symbolic links are rejected.</Callout>
        {pct !== null && <Progress value={pct} />}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!file || !name.trim()}
            loading={pct !== null}
            onClick={async () => {
              setPct(0);
              try {
                await upload(`/api/servers/${serverId}/worlds/import?name=${encodeURIComponent(name.trim())}`, file!, setPct);
                toast.success("World imported");
                onOpenChange(false);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setPct(null);
              }
            }}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
