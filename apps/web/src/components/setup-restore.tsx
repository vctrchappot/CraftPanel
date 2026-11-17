"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button, Callout, Field, Input, Progress } from "@craftpanel/ui";
import { API_BASE, ApiError, errorMessage, setCsrfToken, uploadForm } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface RestoreState { running: boolean; message: string; error: string | null; recoveryRequired?: boolean; result: { servers: number; withFiles: number; backups: number; notes: string[] } | null }

export function SetupRestore({ needsToken, setupToken, onTokenChange, onBack }: { needsToken: boolean; setupToken: string; onTokenChange: (token: string) => void; onBack: () => void }) {
  const router = useRouter();
  const { refresh } = useAuth();
  const [file, setFile] = React.useState<File | null>(null);
  const [passphrase, setPassphrase] = React.useState("");
  const [token, setToken] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [percent, setPercent] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const refreshed = React.useRef(false);
  const state = useQuery({
    queryKey: ["setup-restore", token],
    enabled: !!token,
    queryFn: async () => {
      const response = await fetch(API_BASE + "/api/auth/restore/status", { credentials: "include", headers: { "x-restore-token": token! } });
      const data = await response.json();
      if (!response.ok) throw new ApiError(response.status, data.error?.code, data.error?.message ?? "The restore connection was lost");
      return data as RestoreState;
    },
    retry: false,
    refetchInterval: (query) => query.state.error || query.state.data?.running === false ? false : 1000,
  });
  React.useEffect(() => {
    if (state.data?.result && !refreshed.current) { refreshed.current = true; setCsrfToken(null); void refresh(); }
  }, [state.data, refresh]);
  const result = state.data?.result;
  if (result) return <div className="space-y-4">
    <Callout variant="success" title="CraftPanel restored">{result.servers} server{result.servers === 1 ? "" : "s"}, {result.withFiles} with files and worlds, and {result.backups} earlier backup{result.backups === 1 ? "" : "s"} restored.</Callout>
    <p className="text-sm text-muted-foreground">Sign in with the account from the backup. Servers download their game files again and start if they had automatic start. Your two-factor sign-in still applies.</p>
    {!!result.notes.length && <Callout title="After the move"><ul className="list-disc space-y-2 pl-4 break-words">{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></Callout>}
    <Button className="w-full" onClick={() => router.replace("/login/")}>Sign in with the restored account</Button>
  </div>;
  const busy = uploading || (!!token && !state.data?.error && !state.error);
  const tooLarge = !!file && file.size > 2 * 1024 ** 3;
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Restore an application backup from Settings → Backups. Its accounts, settings, servers and any included backup history become this installation.</p>
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      if (!file) return;
      setUploading(true); setError(null); setPercent(0);
      try {
        const data = new FormData();
        if (passphrase) data.append("passphrase", passphrase);
        data.append("file", file);
        const result = await uploadForm<{ token: string }>("/api/auth/restore", data, setPercent, needsToken ? { "x-setup-token": setupToken } : {});
        setPassphrase(""); setToken(result.token);
      } catch (err) { setError(errorMessage(err)); }
      finally { setUploading(false); }
    }}>
      {needsToken && <Field label="Setup token" htmlFor="restore-setup-token" help="From the CraftPanel log or setup-token.txt on this computer."><Input id="restore-setup-token" value={setupToken} onChange={(e) => onTokenChange(e.target.value)} disabled={busy} required autoComplete="off" /></Field>}
      <Field label="Application backup" htmlFor="restore-file" help="A .zip or encrypted .cpbackup file, up to 2 GB."><Input id="restore-file" type="file" accept=".zip,.cpbackup,application/zip,application/octet-stream" disabled={busy} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Backup passphrase (if encrypted)" htmlFor="restore-passphrase"><Input id="restore-passphrase" type="password" autoComplete="off" maxLength={1024} value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} /></Field>
      {tooLarge && <Callout variant="warning" title="Use offline import for this file">For backups over 2 GB, stop CraftPanel and its runtime and run <code className="break-all">node apps/api/dist/index.js import-backup &lt;file&gt; [--passphrase-file &lt;file&gt;]</code> as the dashboard&apos;s account.</Callout>}
      {(error || state.data?.error) && <Callout variant="danger" title="Restoration failed">{error ?? state.data?.error}{state.data?.recoveryRequired && <p className="mt-2">Restart CraftPanel to recover the previous installation. Its recovery files have been kept.</p>}</Callout>}
      {state.error && <Callout variant="warning" title="Restore connection lost">Reload this page to check whether restoration completed.<Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button></Callout>}
      {busy && <div role="status" className="space-y-2"><Progress value={uploading ? percent : null} /><p className="text-xs text-muted-foreground">{uploading ? `Uploading ${percent}%` : state.data?.message ?? "Checking the backup"}</p></div>}
      <Button type="submit" className="w-full" loading={busy} disabled={!file || tooLarge || !!state.data?.recoveryRequired || (needsToken && !setupToken)}>Restore backup</Button>
    </form>
    <Button variant="secondary" className="w-full" disabled={busy || !!state.data?.recoveryRequired} onClick={onBack}>Create a new installation instead</Button>
  </div>;
}
