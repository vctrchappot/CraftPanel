"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, File, FileArchive, FileText, Folder, FolderPlus, Home, MoreHorizontal, Pencil, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Panel,
  Skeleton,
  Textarea,
} from "@craftpanel/ui";
import type { FileEntry, ServerDetail } from "@craftpanel/shared";
import { api, downloadUrl, errorMessage, upload } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { formatBytes, timeAgo } from "@/lib/format";

const TEXT_EXT = /\.(txt|properties|json|ya?ml|toml|cfg|conf|ini|log|md|mcmeta|sk|js|csv|xml|lang)$/i;

export function FilesTab({ server: s }: { server: ServerDetail }) {
  const canRead = useCan("files.read");
  const canWrite = useCan("files.write");
  const [path, setPath] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const key = ["files", s.id, path];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ entries: FileEntry[] }>(`/api/servers/${s.id}/files?path=${encodeURIComponent(path)}`), enabled: canRead });
  const refresh = () => qc.invalidateQueries({ queryKey: ["files", s.id] });
  const [mkdir, setMkdir] = React.useState(false);
  const [renaming, setRenaming] = React.useState<FileEntry | null>(null);
  const [deleting, setDeleting] = React.useState<FileEntry | null>(null);
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const zipInput = React.useRef<HTMLInputElement>(null);

  if (!canRead) return <Callout>File access requires the Administrator role.</Callout>;
  if (editing) return <Editor serverId={s.id} path={editing} readOnly={!canWrite} onClose={() => setEditing(null)} />;

  const crumbs = path ? path.split("/") : [];
  const doUpload = async (f: File, extract: boolean) => {
    setUploadPct(0);
    try {
      await upload(`/api/servers/${s.id}/files/upload?path=${encodeURIComponent(path)}${extract ? "&extract=true" : ""}`, f, setUploadPct);
      toast.success(extract ? "Archive extracted" : `${f.name} uploaded`);
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploadPct(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-[13px]" aria-label="Breadcrumb">
          <button onClick={() => setPath("")} className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Home className="size-3.5" /> Server
          </button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))} className="truncate rounded px-1.5 py-1 hover:bg-muted">
                {c}
              </button>
            </React.Fragment>
          ))}
        </nav>
        {canWrite && (
          <>
            <input ref={fileInput} type="file" hidden onChange={(e) => (e.target.files?.[0] && doUpload(e.target.files[0], false), (e.target.value = ""))} />
            <input ref={zipInput} type="file" accept=".zip" hidden onChange={(e) => (e.target.files?.[0] && doUpload(e.target.files[0], true), (e.target.value = ""))} />
            <Button size="sm" variant="secondary" onClick={() => setMkdir(true)}>
              <FolderPlus /> Folder
            </Button>
            <Button size="sm" variant="secondary" onClick={() => zipInput.current?.click()} disabled={uploadPct !== null}>
              <FileArchive /> Upload & extract zip
            </Button>
            <Button size="sm" onClick={() => fileInput.current?.click()} loading={uploadPct !== null}>
              <Upload /> {uploadPct !== null ? `${uploadPct}%` : "Upload"}
            </Button>
          </>
        )}
      </div>

      <Panel className="overflow-x-auto">
        {q.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-7" />)}</div>
        ) : q.error ? (
          <p className="p-4 text-[13px] text-destructive">{errorMessage(q.error)}</p>
        ) : (
          <table className="w-full min-w-[520px] text-[13px]">
            <tbody className="divide-y divide-border">
              {path && (
                <tr className="cursor-pointer hover:bg-muted/50" onClick={() => setPath(crumbs.slice(0, -1).join("/"))}>
                  <td className="px-4 py-2 text-muted-foreground" colSpan={4}>
                    ..
                  </td>
                </tr>
              )}
              {q.data?.entries.map((e) => (
                <tr key={e.path} className="group hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <button
                      className="flex items-center gap-2.5 text-left hover:underline"
                      onClick={() => (e.type === "directory" ? setPath(e.path) : TEXT_EXT.test(e.name) || e.size < 1024 * 1024 ? setEditing(e.path) : downloadUrl(`/api/servers/${s.id}/files/download?path=${encodeURIComponent(e.path)}`))}
                    >
                      {e.type === "directory" ? <Folder className="size-4 text-muted-foreground" /> : TEXT_EXT.test(e.name) ? <FileText className="size-4 text-muted-foreground" /> : <File className="size-4 text-muted-foreground" />}
                      {e.name}
                    </button>
                  </td>
                  <td className="w-24 px-4 py-2 text-right tabular-nums text-muted-foreground">{e.type === "file" ? formatBytes(e.size) : ""}</td>
                  <td className="w-36 px-4 py-2 text-muted-foreground">{timeAgo(e.modifiedAt)}</td>
                  <td className="w-12 px-2 py-1 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${e.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {e.type === "file" && (
                          <DropdownMenuItem onSelect={() => setEditing(e.path)}>
                            <FileText /> {canWrite ? "Edit" : "View"}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => downloadUrl(`/api/servers/${s.id}/files/download?path=${encodeURIComponent(e.path)}`)}>
                          <Download /> {e.type === "directory" ? "Download as zip" : "Download"}
                        </DropdownMenuItem>
                        {canWrite && (
                          <>
                            <DropdownMenuItem onSelect={() => setRenaming(e)}>
                              <Pencil /> Rename / move
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onSelect={() => setDeleting(e)}>
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
              {q.data?.entries.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-muted-foreground" colSpan={4}>
                    This folder is empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="text-xs text-muted-foreground">Access is limited to this server&apos;s directory. Symbolic links are hidden and cannot be followed.</p>

      <NameDialog
        open={mkdir}
        onOpenChange={setMkdir}
        title="New folder"
        initial=""
        submitLabel="Create"
        onSubmit={async (name) => {
          await api.post(`/api/servers/${s.id}/files/mkdir`, { path: path ? `${path}/${name}` : name });
          void refresh();
        }}
      />
      <NameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename or move"
        initial={renaming?.path ?? ""}
        submitLabel="Save"
        help="Path relative to the server folder."
        onSubmit={async (to) => {
          await api.post(`/api/servers/${s.id}/files/rename`, { from: renaming!.path, to });
          void refresh();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description={deleting?.type === "directory" ? "The folder and everything inside it will be permanently deleted." : "The file will be permanently deleted."}
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await api.del(`/api/servers/${s.id}/files?path=${encodeURIComponent(deleting!.path)}`);
            void refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

function NameDialog({ open, onOpenChange, title, initial, submitLabel, help, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; initial: string; submitLabel: string; help?: string; onSubmit: (v: string) => Promise<void> }) {
  const [value, setValue] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setValue(initial), [initial, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={title} />
        <Field label="Name" htmlFor="fname" help={help}>
          <Input id="fname" value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="font-mono text-xs" />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!value.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(value.trim());
                onOpenChange(false);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Editor({ serverId, path, readOnly, onClose }: { serverId: string; path: string; readOnly: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ["file", serverId, path], queryFn: () => api.get<{ content: string }>(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`), gcTime: 0 });
  const [content, setContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  React.useEffect(() => {
    if (q.data) setContent(q.data.content);
  }, [q.data]);
  const dirty = content !== null && q.data && content !== q.data.content;
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/servers/${serverId}/files/content`, { path, content: content ?? "" });
      toast.success("Saved");
      await q.refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setDiscardOpen(true) : onClose())}>
          ← Files
        </Button>
        <p className="min-w-0 flex-1 truncate font-mono text-[13px]">{path}</p>
        {!readOnly && (
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
            <Save /> Save
          </Button>
        )}
      </div>
      {q.error ? (
        <Callout variant="danger">{errorMessage(q.error)}</Callout>
      ) : content === null ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              if (dirty) void save();
            }
          }}
          className="scrollbar-thin h-[65vh] resize-none rounded-lg p-4 font-mono text-[12px] leading-relaxed"
          aria-label={`Contents of ${path}`}
        />
      )}
      {path === "server.properties" && <p className="text-xs text-muted-foreground">Tip: the Settings tab offers a validated editor for this file.</p>}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard unsaved changes?"
        description={`Your edits to ${path} have not been saved and will be lost.`}
        confirmLabel="Discard changes"
        destructive
        onConfirm={onClose}
      />
    </div>
  );
}
