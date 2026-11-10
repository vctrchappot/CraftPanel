"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Plug, RefreshCw, Save, XCircle } from "lucide-react";
import { Button, Callout, ChoiceCard, Field, Input, NativeSelect, Panel, Section, SegmentedControl, Skeleton, Switch, Textarea } from "@craftpanel/ui";
import {
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
  const save = useAction((s: AssistantSettings) => api.put("/api/assistant/settings", { ...s }), { success: "AI assistant settings saved", invalidate: [["assistant-settings"], ["assistant"]], onSuccess: () => setF(null) });
  const [test, setTest] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [models, setModels] = React.useState<{ list: string[] | null; loading: boolean; error: string | null }>({ list: null, loading: false, error: null });
  const request = React.useRef(0);

  // Key, address and provider are enough to ask the provider for its models.
  const ready = !!f && (ASSISTANT_PROVIDER_INFO[f.provider].keyRequired ? !!f.apiKey : f.provider !== "openai-compatible" || !!f.baseUrl);
  const canList = ready && !!f && /^https?:\/\/\S+$|^$/.test(f.baseUrl);
  const loadModels = React.useCallback(async () => {
    if (!f) return;
    const id = ++request.current;
    setModels((m) => ({ ...m, loading: true, error: null }));
    try {
      const r = await api.post<{ models: string[] }>("/api/assistant/settings/models", { ...f });
      if (id === request.current) setModels({ list: r.models, loading: false, error: null });
    } catch (err) {
      if (id === request.current) setModels({ list: null, loading: false, error: errorMessage(err) });
    }
  }, [f]);
  // Load the list on its own once the connection details are filled in (and again when they change).
  const listKey = f ? `${f.provider} ${f.baseUrl} ${f.apiKey}` : "";
  React.useEffect(() => {
    request.current++;
    setModels({ list: null, loading: false, error: null });
    if (!canList) return;
    const t = setTimeout(() => void loadModels(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the connection details matter, not the rest of the form
  }, [listKey, canList]);

  if (!f) return q.error ? <Callout variant="danger">{errorMessage(q.error)}</Callout> : <Skeleton className="h-64 rounded-lg" />;
  const set = (patch: Partial<AssistantSettings>) => {
    setF({ ...f, ...patch });
    setTest(null);
  };
  // Another provider starts from its own defaults; going back to the saved one restores its key and model.
  const pickProvider = (p: AssistantProvider) => {
    const saved = q.data?.provider === p ? q.data : null;
    set({ provider: p, apiKey: saved?.apiKey ?? "", model: saved?.model ?? ASSISTANT_PROVIDER_INFO[p].defaultModel, baseUrl: saved?.baseUrl ?? "" });
  };
  const runTest = async () => {
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
  };
  const info = ASSISTANT_PROVIDER_INFO[f.provider];
  const dirty = JSON.stringify(f) !== JSON.stringify(q.data);

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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Provider">
          {ASSISTANT_PROVIDERS.map((p) => (
            <ChoiceCard
              key={p}
              role="radio"
              aria-checked={f.provider === p}
              selected={f.provider === p}
              onClick={() => p !== f.provider && pickProvider(p)}
              className="flex flex-col items-start gap-0.5 px-3 py-2.5 text-left"
            >
              <span className="text-[13px] font-medium">{ASSISTANT_PROVIDER_INFO[p].label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{ASSISTANT_PROVIDER_INFO[p].note}</span>
            </ChoiceCard>
          ))}
        </div>

        <Panel className="space-y-4 p-4">
          {!info.local && (
            <Field
              label="API key"
              htmlFor="ai-key"
              help={info.keyRequired ? "Stored on this computer and never shown again." : "Only if the service asks for one."}
              aside={
                info.keyUrl && (
                  <a href={info.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    Create a key at {new URL(info.keyUrl).hostname} <ExternalLink className="size-3" />
                  </a>
                )
              }
            >
              <Input id="ai-key" type="password" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} placeholder={info.keyPlaceholder} autoComplete="new-password" spellCheck={false} />
            </Field>
          )}
          {(info.local || !info.defaultBaseUrl) && (
            <Field label="Address" htmlFor="ai-base" help={info.local ? `Leave empty for ${info.label} on this computer. Another computer: its address, ending in /v1.` : "The API address ending in /v1 (or the provider's equivalent)."}>
              <Input id="ai-base" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} placeholder={info.defaultBaseUrl || "https://…/v1"} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field
            label="Model"
            htmlFor="ai-model"
            help={models.error ? <span className="text-destructive">{models.error}</span> : modelHelp(f.provider, models.list)}
            aside={
              <Button variant="ghost" size="xs" loading={models.loading} disabled={!canList} onClick={() => loadModels()}>
                <RefreshCw /> {models.list ? "Reload list" : "Load models"}
              </Button>
            }
          >
            <Input id="ai-model" list="ai-models" value={f.model} onChange={(e) => set({ model: e.target.value.trim() })} placeholder={info.defaultModel || (models.list?.length ? "Pick or type a model" : "model name")} autoComplete="off" spellCheck={false} />
            <datalist id="ai-models">
              {models.list?.map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>
          {!info.local && info.defaultBaseUrl && (
            <details className="group text-[13px]" open={!!f.baseUrl || undefined}>
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Custom address (proxy or gateway)</summary>
              <div className="pt-3">
                <Field label="Address" htmlFor="ai-base" help={`Leave empty for ${info.defaultBaseUrl}.`}>
                  <Input id="ai-base" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} placeholder={info.defaultBaseUrl} autoComplete="off" spellCheck={false} />
                </Field>
              </div>
            </details>
          )}
          {info.local && <p className="text-xs text-muted-foreground">A model on this computer keeps everything local. It needs to support tool calling; small models often get multi-step tasks wrong.</p>}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button variant="secondary" size="sm" loading={testing} disabled={!f.model || !ready} onClick={runTest}>
              <Plug /> Test connection
            </Button>
            {test && (
              <span className={`flex min-w-0 items-center gap-1.5 text-[13px] ${test.ok ? "text-success" : "text-destructive"}`}>
                {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                <span className="truncate">{test.ok ? `Connected: “${test.text}”` : test.text}</span>
              </span>
            )}
            {test?.ok && !f.enabled && (
              <Button size="sm" className="ml-auto" loading={save.isPending} onClick={() => save.mutate({ ...f, enabled: true })}>
                Turn on and save
              </Button>
            )}
          </div>
        </Panel>
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

      <Button onClick={() => save.mutate(f)} loading={save.isPending} disabled={!dirty}>
        <Save /> Save
      </Button>
    </div>
  );
}

function modelHelp(p: AssistantProvider, list: string[] | null) {
  const found = list ? `${list.length} model${list.length === 1 ? "" : "s"} available; type to filter. ` : "";
  if (p === "anthropic") return `${found}claude-sonnet-5-5 or claude-haiku-5-5 cost less than claude-opus-5-5.`;
  if (p === "deepseek") return `${found}deepseek-chat answers directly; deepseek-reasoner thinks first and answers more slowly.`;
  if (p === "ollama" || p === "lmstudio") return list ? found.trim() : "Start the app, then load the list, or type the name, e.g. llama3.3.";
  if (list) return `${found}Pick one that supports tool calling.`;
  return "Enter the key above to load the list, or type the name as the provider writes it.";
}
