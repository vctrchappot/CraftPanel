"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Plug, Save, XCircle } from "lucide-react";
import { Button, Callout, ChoiceCard, Field, Input, NativeSelect, Panel, Section, SegmentedControl, Skeleton, Switch, Textarea } from "@craftpanel/ui";
import {
  ASSISTANT_ENDPOINT_PRESETS,
  ASSISTANT_PROVIDER_INFO,
  ASSISTANT_PROVIDERS,
  ASSISTANT_TOOL_GROUP_INFO,
  ASSISTANT_TOOL_GROUPS,
  ROLE_LABELS,
  ROLES,
  type AssistantProvider,
  type AssistantSettings,
} from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useAction } from "@/lib/queries";

/** Settings → AI assistant (owner): provider, key, model and what the assistant may do. */
export function AssistantSettingsSection() {
  const q = useQuery({ queryKey: ["assistant-settings"], queryFn: () => api.get<AssistantSettings>("/api/assistant/settings") });
  const [f, setF] = React.useState<AssistantSettings | null>(null);
  React.useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  // After saving, start over from the stored (redacted) values so the form is clean again.
  const save = useAction(() => api.put("/api/assistant/settings", { ...f! }), { success: "AI assistant settings saved", invalidate: [["assistant-settings"], ["assistant"]], onSuccess: () => setF(null) });
  const [test, setTest] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = React.useState(false);

  if (!f) return q.error ? <Callout variant="danger">{errorMessage(q.error)}</Callout> : <Skeleton className="h-64 rounded-lg" />;
  const set = (patch: Partial<AssistantSettings>) => {
    setF({ ...f, ...patch });
    setTest(null);
  };
  const info = ASSISTANT_PROVIDER_INFO[f.provider];
  const dirty = JSON.stringify(f) !== JSON.stringify(q.data);
  const local = /^http:\/\/(localhost|127\.|\[::1\])/.test(f.baseUrl);

  return (
    <div className="max-w-2xl space-y-8">
      <Section
        title="AI assistant"
        description="Ask in plain language: “Why is survival lagging?”, “Whitelist Alex and restart at 4 am”. The assistant reads and acts through CraftPanel with the permissions of the person asking. You bring the API key; nothing is sent anywhere until you turn it on."
      >
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-[13px]">
          <div>
            <p className="font-medium">Turn on the assistant</p>
            <p className="text-xs text-muted-foreground">Shows the assistant button in the dashboard for everyone allowed to use it.</p>
          </div>
          <Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Turn on the AI assistant" />
        </div>
      </Section>

      <Section title="Provider" description="Requests go from this computer straight to the provider you choose, with your key. Usage is billed by the provider.">
        <div className="grid gap-2 sm:grid-cols-3">
          {ASSISTANT_PROVIDERS.map((p) => (
            <ChoiceCard
              key={p}
              selected={f.provider === p}
              onClick={() => set({ provider: p, model: p === f.provider ? f.model : ASSISTANT_PROVIDER_INFO[p].defaultModel, baseUrl: p === f.provider ? f.baseUrl : "" })}
              className="px-3 py-2.5 text-left text-[13px] font-medium"
            >
              {ASSISTANT_PROVIDER_INFO[p].label}
            </ChoiceCard>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API key" htmlFor="ai-key" help={info.keyRequired ? "Stored on this computer and never shown again." : "Optional; local servers such as Ollama need none."}>
            <Input id="ai-key" type="password" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={f.provider === "anthropic" ? "sk-ant-…" : "sk-…"} autoComplete="new-password" spellCheck={false} />
          </Field>
          <Field label="Model" htmlFor="ai-model" help={modelHelp(f.provider)}>
            <Input id="ai-model" value={f.model} onChange={(e) => set({ model: e.target.value.trim() })} placeholder={info.defaultModel || "model name"} autoComplete="off" spellCheck={false} />
          </Field>
          {f.provider !== "anthropic" && (
            <Field
              label="Base URL"
              htmlFor="ai-base"
              className="sm:col-span-2"
              help={f.provider === "openai" ? "Leave empty for api.openai.com." : "The address ending in /v1 (or the provider's equivalent)."}
              aside={
                f.provider === "openai-compatible" && (
                  <NativeSelect aria-label="Known providers" className="h-7 w-auto text-xs" value="" onChange={(e) => e.target.value && set({ baseUrl: e.target.value })}>
                    <option value="">Fill in…</option>
                    {ASSISTANT_ENDPOINT_PRESETS.map((p) => (
                      <option key={p.baseUrl} value={p.baseUrl}>
                        {p.label}
                      </option>
                    ))}
                  </NativeSelect>
                )
              }
            >
              <Input id="ai-base" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} placeholder={info.defaultBaseUrl || "https://…/v1"} autoComplete="off" spellCheck={false} />
            </Field>
          )}
        </div>
        {local && <p className="text-xs text-muted-foreground">A model on this computer keeps everything local. It needs to support tool calling; small models often get multi-step tasks wrong.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            loading={testing}
            disabled={!f.model}
            onClick={async () => {
              setTesting(true);
              setTest(null);
              try {
                const r = await api.post<{ reply: string }>("/api/assistant/settings/test", { ...f });
                setTest({ ok: true, text: r.reply });
              } catch (err) {
                setTest({ ok: false, text: errorMessage(err) });
              } finally {
                setTesting(false);
              }
            }}
          >
            <Plug /> Test connection
          </Button>
          {test && (
            <span className={`flex min-w-0 items-center gap-1.5 text-[13px] ${test.ok ? "text-success" : "text-destructive"}`}>
              {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
              <span className="truncate">{test.ok ? `Connected: “${test.text}”` : test.text}</span>
            </span>
          )}
        </div>
      </Section>

      <Section title="Approvals" description="Reading is always allowed. Decide which changes wait for a click on Approve.">
        <SegmentedControl
          aria-label="When to ask for approval"
          value={f.approval}
          onValueChange={(v) => set({ approval: v })}
          options={[
            { value: "always", label: "Ask before every change" },
            { value: "risky", label: "Ask only before risky changes" },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {f.approval === "always"
            ? "Every start, restart, backup, setting or player change waits for approval."
            : "Starting, restarting, backups, whitelisting and settings run at once. Stopping, console commands, bans, operators, plugin installs, file writes and command schedules still ask."}
        </p>
      </Section>

      <Section title="What it may do" description="Switched-off areas are not offered to the model at all. Within the rest, each user can only do what their role allows.">
        <Panel>
          <ul className="divide-y divide-border">
            {ASSISTANT_TOOL_GROUPS.map((g) => (
              <li key={g} className="flex items-center justify-between gap-4 px-4 py-3 text-[13px]">
                <div>
                  <p className="font-medium">{ASSISTANT_TOOL_GROUP_INFO[g].label}</p>
                  <p className="text-xs text-muted-foreground">{ASSISTANT_TOOL_GROUP_INFO[g].description}</p>
                </div>
                <Switch
                  checked={f.toolGroups.includes(g)}
                  onCheckedChange={(on) => set({ toolGroups: on ? [...f.toolGroups, g] : f.toolGroups.filter((x) => x !== g) })}
                  aria-label={ASSISTANT_TOOL_GROUP_INFO[g].label}
                />
              </li>
            ))}
          </ul>
        </Panel>
        {f.toolGroups.includes("files") && (
          <Callout variant="warning">File access lets the assistant read configuration files, which can contain passwords, and send them to the provider. Writing files always asks first.</Callout>
        )}
      </Section>

      <Section title="Access and limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who can use it" htmlFor="ai-role" help="This role or higher, on at least one server.">
            <NativeSelect id="ai-role" value={f.minRole} onChange={(e) => set({ minRole: e.target.value as AssistantSettings["minRole"] })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Steps per request" htmlFor="ai-steps" help="Model calls before it has to answer. Limits cost when something loops.">
            <Input id="ai-steps" type="number" min={1} max={30} value={f.maxSteps} onChange={(e) => set({ maxSteps: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
        </div>
        <Field label="House rules" htmlFor="ai-rules" help="Added to every conversation, e.g. “Never ban without a reason. Restarts only between 2 and 6 am.”">
          <Textarea id="ai-rules" rows={3} maxLength={4000} value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </Section>

      <Callout variant="info" title="Privacy">
        What users ask, plus the console lines, player names and settings the assistant reads, go to the provider. Conversations are kept in memory on this computer only and are gone after a restart. Every change appears in the audit log as “user (AI assistant)”.
      </Callout>

      <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
        <Save /> Save
      </Button>
    </div>
  );
}

function modelHelp(p: AssistantProvider) {
  if (p === "anthropic") return "For example claude-opus-5-5, or claude-sonnet-5-5 / claude-haiku-5-5 for lower cost.";
  if (p === "openai") return "The model name from your OpenAI account.";
  return "As the provider names it, e.g. llama3.3 in Ollama.";
}
