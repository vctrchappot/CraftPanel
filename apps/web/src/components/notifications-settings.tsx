"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, CheckCircle2, Send, XCircle } from "lucide-react";
import { Button, Callout, Field, Input, NativeSelect, Panel, Section, Skeleton, Switch } from "@craftpanel/ui";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useAction } from "@/lib/queries";

type EmailSettings = {
  enabled: boolean;
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string;
  password: string;
  from: string;
  to: string;
};
type NotifyForm = {
  notifyDiscordWebhook: string;
  notifyEmail: EmailSettings;
  notifyEvents: NotificationCategory[];
};

const CATEGORY_TEXT: Record<NotificationCategory, { label: string; help: string }> = {
  server: { label: "Server problems", help: "A server crashes, stops unexpectedly, fails to start or to install." },
  backup: { label: "Failed backups", help: "A manual or scheduled backup could not be created." },
  schedule: { label: "Failed scheduled tasks", help: "A scheduled restart, command or Dynamic DNS update failed." },
  update: { label: "CraftPanel updates", help: "A new CraftPanel release is available (checked every few hours)." },
};

const PORTS = { tls: 465, starttls: 587, none: 25 } as const;

export function NotificationSettings() {
  const q = useQuery({ queryKey: ["app-settings"], queryFn: () => api.get<NotifyForm>("/api/settings") });
  const [f, setF] = React.useState<NotifyForm | null>(null);
  React.useEffect(() => {
    if (q.data && !f) setF({ notifyDiscordWebhook: q.data.notifyDiscordWebhook, notifyEmail: q.data.notifyEmail, notifyEvents: q.data.notifyEvents });
  }, [q.data, f]);
  // After saving, start over from the stored (redacted) values so the form is clean again.
  const save = useAction(() => api.put("/api/settings", f!), { success: "Notification settings saved", invalidate: [["app-settings"]], onSuccess: () => setF(null) });
  const [results, setResults] = React.useState<{ channel: string; ok: boolean; error?: string }[] | null>(null);
  const [testing, setTesting] = React.useState(false);

  if (!f) return q.error ? <Callout variant="danger">{errorMessage(q.error)}</Callout> : <Skeleton className="h-64 rounded-xl" />;
  const email = f.notifyEmail;
  const setEmail = (patch: Partial<EmailSettings>) => setF({ ...f, notifyEmail: { ...email, ...patch } });
  const dirty = JSON.stringify(f) !== JSON.stringify({ notifyDiscordWebhook: q.data?.notifyDiscordWebhook, notifyEmail: q.data?.notifyEmail, notifyEvents: q.data?.notifyEvents });

  return (
    <div className="max-w-2xl space-y-8">
      <Section title="Discord" description="Messages go to a channel through a webhook. In Discord: Server settings → Integrations → Webhooks → New webhook → Copy Webhook URL.">
        <Field label="Webhook URL" htmlFor="discord" help="Leave empty to turn Discord notifications off. The URL is a secret; it is not shown again after saving.">
          <Input id="discord" value={f.notifyDiscordWebhook} onChange={(e) => setF({ ...f, notifyDiscordWebhook: e.target.value })} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" spellCheck={false} />
        </Field>
      </Section>

      <Section title="E-mail" description="Sent through your mail provider's SMTP server (e.g. your e-mail account, or a service such as Brevo or Mailgun).">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-[13px]">
          <span>Send e-mails</span>
          <Switch checked={email.enabled} onCheckedChange={(v) => setEmail({ enabled: v })} aria-label="Send e-mails" />
        </div>
        {email.enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP server" htmlFor="smtp-host">
              <Input id="smtp-host" value={email.host} onChange={(e) => setEmail({ host: e.target.value.trim() })} placeholder="smtp.example.com" autoComplete="off" />
            </Field>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="Encryption" htmlFor="smtp-sec">
                <NativeSelect id="smtp-sec" value={email.security} onChange={(e) => setEmail({ security: e.target.value as EmailSettings["security"], port: PORTS[e.target.value as EmailSettings["security"]] })}>
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">TLS / SSL</option>
                  <option value="none">None (local relay)</option>
                </NativeSelect>
              </Field>
              <Field label="Port" htmlFor="smtp-port">
                <Input id="smtp-port" type="number" min={1} max={65535} value={email.port} onChange={(e) => setEmail({ port: Number(e.target.value) || 0 })} />
              </Field>
            </div>
            <Field label="Username" htmlFor="smtp-user" help="Often your e-mail address. Leave empty if the server needs no login.">
              <Input id="smtp-user" value={email.username} onChange={(e) => setEmail({ username: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Password" htmlFor="smtp-pass" help="Many providers need an app password here.">
              <Input id="smtp-pass" type="password" value={email.password} onChange={(e) => setEmail({ password: e.target.value })} autoComplete="new-password" />
            </Field>
            <Field label="Sender" htmlFor="smtp-from" help="Defaults to the username.">
              <Input id="smtp-from" value={email.from} onChange={(e) => setEmail({ from: e.target.value })} placeholder="craftpanel@example.com" />
            </Field>
            <Field label="Recipients" htmlFor="smtp-to" help="Separate several addresses with commas.">
              <Input id="smtp-to" value={email.to} onChange={(e) => setEmail({ to: e.target.value })} placeholder="you@example.com" />
            </Field>
            {email.security === "none" && (
              <Callout variant="warning" className="sm:col-span-2">
                Without encryption the password and messages travel in plain text. Use this only for a mail relay on this machine or your own network.
              </Callout>
            )}
          </div>
        )}
      </Section>

      <Section title="Notify me about">
        <Panel>
          <ul className="divide-y divide-border">
            {NOTIFICATION_CATEGORIES.map((c) => (
              <li key={c} className="flex items-center justify-between gap-4 px-4 py-3 text-[13px]">
                <div>
                  <p className="font-medium">{CATEGORY_TEXT[c].label}</p>
                  <p className="text-xs text-muted-foreground">{CATEGORY_TEXT[c].help}</p>
                </div>
                <Switch
                  checked={f.notifyEvents.includes(c)}
                  onCheckedChange={(on) => setF({ ...f, notifyEvents: on ? [...f.notifyEvents, c] : f.notifyEvents.filter((x) => x !== c) })}
                  aria-label={CATEGORY_TEXT[c].label}
                />
              </li>
            ))}
          </ul>
        </Panel>
        <p className="text-xs text-muted-foreground">The same problem on the same server is reported at most once every 10 minutes.</p>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
          <Bell /> Save
        </Button>
        <Button
          variant="secondary"
          loading={testing}
          disabled={dirty}
          title={dirty ? "Save first" : undefined}
          onClick={async () => {
            setTesting(true);
            setResults(null);
            try {
              setResults(await api.post<{ channel: string; ok: boolean; error?: string }[]>("/api/settings/notifications/test"));
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setTesting(false);
            }
          }}
        >
          <Send /> Send test
        </Button>
      </div>
      {results && (
        <ul className="space-y-1.5 text-[13px]">
          {results.map((r) => (
            <li key={r.channel} className="flex items-center gap-2">
              {r.ok ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-destructive" />}
              <span className="font-medium">{r.channel === "discord" ? "Discord" : "E-mail"}:</span>
              <span className={r.ok ? "text-muted-foreground" : "text-destructive"}>{r.ok ? "sent" : r.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
