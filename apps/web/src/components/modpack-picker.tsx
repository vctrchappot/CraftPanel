"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, ChevronLeft, Search, Upload } from "lucide-react";
import { Badge, Button, Callout, Field, Input, NativeSelect, Panel, Skeleton } from "@craftpanel/ui";
import type { ServerSoftware } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatNumber } from "@/lib/format";

export interface PreparedModpack {
  id: string;
  info: { name: string; version: string; summary: string; mcVersion: string; software: ServerSoftware; loader: string | null; serverFiles: number; clientOnlyFiles: number; downloadBytes: number };
  source: { projectId: string | null; versionId: string } | null;
}
interface ModpackHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
}
interface ModpackVersion {
  id: string;
  name: string;
  versionNumber: string;
  mcVersions: string[];
  published: string;
  fileSize: number;
}

/** Pick a Fabric or NeoForge modpack from Modrinth or upload a .mrpack; the API downloads and checks it before the server is created. */
export function ModpackPicker({ value, onChange }: { value: PreparedModpack | null; onChange: (p: PreparedModpack | null) => void }) {
  const [project, setProject] = React.useState<ModpackHit | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const prepare = async (run: () => Promise<PreparedModpack>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await run());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (value) return <PreparedSummary pack={value} onChange={() => (onChange(null), setError(null))} />;

  return (
    <div className="space-y-4">
      {error && (
        <Callout variant="danger" icon={<AlertTriangle />} title="This modpack can't be used">
          {error}
        </Callout>
      )}
      {project ? (
        <Versions project={project} busy={busy} onBack={() => setProject(null)} onPick={(v) => prepare(() => api.post<PreparedModpack>("/api/modpacks/modrinth", { versionId: v }))} />
      ) : (
        <Catalogue onPick={setProject} />
      )}
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <span>Have a .mrpack file?</span>
        <Button size="sm" variant="secondary" loading={busy && !project} onClick={() => fileRef.current?.click()}>
          <Upload /> Upload .mrpack
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".mrpack,.zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const fd = new FormData();
            fd.append("file", file);
            void prepare(() => api.post<PreparedModpack>("/api/modpacks/upload", fd));
          }}
        />
      </div>
    </div>
  );
}

function Catalogue({ onPick }: { onPick: (p: ModpackHit) => void }) {
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(t);
  }, [query]);
  const q = useQuery({
    queryKey: ["modpacks", debounced],
    queryFn: () => api.get<{ hits: ModpackHit[]; total: number }>(`/api/modpacks/search?q=${encodeURIComponent(debounced)}`),
    staleTime: 300_000,
  });
  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Fabric and NeoForge modpacks on Modrinth…" className="pl-8" aria-label="Search modpacks" />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : q.error ? (
        <Callout variant="danger" icon={<AlertTriangle />}>
          {errorMessage(q.error)}
        </Callout>
      ) : q.data?.hits.length ? (
        <Panel className="max-h-[360px] overflow-y-auto">
          <ul className="divide-y divide-border">
            {q.data.hits.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => onPick(h)} className="flex w-full items-start gap-3 px-4 py-3 text-left text-[13px] transition-colors hover:bg-muted/50">
                  {/* No Modrinth icons: the dashboard makes no third-party requests. */}
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                    <Boxes />
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 font-medium">
                      {h.title}
                      <span className="font-normal text-muted-foreground">by {h.author}</span>
                    </span>
                    <span className="line-clamp-2 block text-muted-foreground">{h.description}</span>
                    <span className="block text-xs text-muted-foreground">{formatNumber(h.downloads)} downloads</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <p className="text-[13px] text-muted-foreground">No server-compatible modpacks found.</p>
      )}
    </div>
  );
}

function Versions({ project, busy, onBack, onPick }: { project: ModpackHit; busy: boolean; onBack: () => void; onPick: (versionId: string) => void }) {
  const q = useQuery({ queryKey: ["modpack-versions", project.id], queryFn: () => api.get<ModpackVersion[]>(`/api/modpacks/${project.id}/versions`), staleTime: 300_000 });
  const [version, setVersion] = React.useState("");
  const chosen = version || q.data?.[0]?.id || "";
  return (
    <Panel className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={busy} aria-label="Back to search">
          <ChevronLeft />
        </Button>
        <div className="min-w-0 space-y-0.5 text-[13px]">
          <p className="font-medium">
            <a href={`https://modrinth.com/modpack/${project.slug}`} target="_blank" rel="noreferrer" className="hover:underline">
              {project.title}
            </a>{" "}
            <span className="font-normal text-muted-foreground">by {project.author}</span>
          </p>
          <p className="text-muted-foreground">{project.description}</p>
        </div>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-9" />
      ) : q.error ? (
        <Callout variant="danger" icon={<AlertTriangle />}>
          {errorMessage(q.error)}
        </Callout>
      ) : q.data?.length ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Version" htmlFor="mpv" className="min-w-0 flex-1">
            <NativeSelect id="mpv" value={chosen} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
              {q.data.map((v, i) => (
                <option key={v.id} value={v.id}>
                  {v.versionNumber} · Minecraft {v.mcVersions.join(", ")}
                  {i === 0 ? " (latest)" : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button onClick={() => onPick(chosen)} loading={busy} disabled={!chosen}>
            Use this version
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">This modpack has no Fabric or NeoForge versions.</p>
      )}
      {busy && <p className="text-xs text-muted-foreground">Downloading the modpack and checking its file list…</p>}
    </Panel>
  );
}

function PreparedSummary({ pack, onChange }: { pack: PreparedModpack; onChange: () => void }) {
  const i = pack.info;
  return (
    <Panel className="space-y-3 p-4 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <Boxes className="size-4 text-muted-foreground" />
            {i.name} {i.version}
            <Badge variant="success">Ready</Badge>
          </p>
          {i.summary && <p className="text-muted-foreground">{i.summary}</p>}
        </div>
        <Button size="sm" variant="secondary" onClick={onChange}>
          Change
        </Button>
      </div>
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Runs on</dt>
        <dd>
          {i.loader ? `${i.software === "neoforge" ? "NeoForge" : "Fabric Loader"} ${i.loader}` : "Vanilla"} · Minecraft {i.mcVersion}
        </dd>
        <dt className="text-muted-foreground">Server files</dt>
        <dd>
          {i.serverFiles} to download ({formatBytes(i.downloadBytes)}){i.clientOnlyFiles ? ` · ${i.clientOnlyFiles} client-only skipped` : ""}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">Every file is checked against the modpack's SHA-512 checksum. Mods are third-party code: only use packs you trust. Players need the same modpack in their launcher to join.</p>
    </Panel>
  );
}
