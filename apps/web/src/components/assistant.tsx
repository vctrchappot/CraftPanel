"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, CircleSlash, Clock, History, Loader2, Plus, SendHorizontal, Sparkles, Square, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Kbd, Textarea } from "@craftpanel/ui";
import type { AssistantConversationView, AssistantItem, AssistantStatus } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useServers } from "@/lib/queries";

type ToolItem = Extract<AssistantItem, { kind: "tool" }>;
const STORAGE_KEY = "craftpanel.assistant.conversation";

export function useAssistantStatus() {
  return useQuery({ queryKey: ["assistant"], queryFn: () => api.get<AssistantStatus>("/api/assistant"), staleTime: 60_000 });
}

/** Opens (or closes) the assistant panel from anywhere, e.g. the sidebar. */
export function toggleAssistant() {
  window.dispatchEvent(new Event("craftpanel:assistant"));
}

/** The assistant's side panel. Rendered by the app frame; hidden until the owner turns it on. */
export function Assistant() {
  const status = useAssistantStatus();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen((o) => !o);
    window.addEventListener("keydown", onKey);
    window.addEventListener("craftpanel:assistant", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("craftpanel:assistant", onOpen);
    };
  }, []);

  if (!status.data?.available) return null;
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/20 sm:hidden" onClick={() => setOpen(false)} />}
      <aside
        role="dialog"
        aria-label="AI assistant"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:w-[440px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <Panel status={status.data} open={open} onClose={() => setOpen(false)} />
      </aside>
    </>
  );
}

function Panel({ status, open, onClose }: { status: AssistantStatus; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const params = useSearchParams();
  const serverId = pathname.startsWith("/server") ? params.get("id") : null;
  const servers = useServers();
  const serverName = servers.data?.find((s) => s.id === serverId)?.name ?? null;

  const [conversationId, setConversationId] = React.useState<string | null>(null);
  React.useEffect(() => {
    try {
      setConversationId(sessionStorage.getItem(STORAGE_KEY));
    } catch {}
  }, []);
  const remember = (id: string | null) => {
    setConversationId(id);
    try {
      if (id) sessionStorage.setItem(STORAGE_KEY, id);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  const conversation = useQuery({
    queryKey: ["assistant-conversation", conversationId],
    queryFn: () => api.get<AssistantConversationView>(`/api/assistant/conversations/${conversationId}`),
    enabled: !!conversationId && open,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 700 : false),
  });
  // A conversation the panel no longer has (restart, expired): start fresh.
  React.useEffect(() => {
    if (conversation.error) remember(null);
  }, [conversation.error]);

  // When a run finishes, refresh what the dashboard shows: the assistant may have changed it.
  const lastStatus = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const s = conversation.data?.status;
    if (lastStatus.current === "running" && s !== "running") void qc.invalidateQueries({ predicate: (q) => !String(q.queryKey[0]).startsWith("assistant") });
    lastStatus.current = s;
  }, [conversation.data?.status, qc]);

  const history = useQuery({
    queryKey: ["assistant-conversations"],
    queryFn: () => api.get<{ id: string; title: string; status: string; updatedAt: number }[]>("/api/assistant/conversations"),
    enabled: open,
  });

  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const data = conversation.data;
  const busy = sending || data?.status === "running";

  const setData = (v: AssistantConversationView) => qc.setQueryData(["assistant-conversation", v.id], v);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setSending(true);
    try {
      const v = await api.post<AssistantConversationView>("/api/assistant/conversations", { message, serverId, conversationId: data ? data.id : undefined });
      setData(v);
      remember(v.id);
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function decide(item: ToolItem, approve: boolean) {
    if (!data) return;
    try {
      setData(await api.post<AssistantConversationView>(`/api/assistant/conversations/${data.id}/decision`, { toolCallId: item.id, approve }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function stop() {
    if (!data) return;
    try {
      setData(await api.post<AssistantConversationView>(`/api/assistant/conversations/${data.id}/cancel`));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const textarea = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (open) setTimeout(() => textarea.current?.focus(), 150);
  }, [open]);

  const scroller = React.useRef<HTMLDivElement>(null);
  const itemCount = data?.items.length ?? 0;
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [itemCount, data?.status]);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Sparkles className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight">Assistant</p>
          <p className="truncate text-[11px] text-muted-foreground">{status.model}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Earlier conversations">
                <History />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>Conversations</DropdownMenuLabel>
              {(history.data ?? []).map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => remember(c.id)} className={cn(c.id === conversationId && "font-medium")}>
                  <span className="truncate">{c.title}</span>
                </DropdownMenuItem>
              ))}
              {!history.data?.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet. They are kept until CraftPanel restarts.</p>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => remember(null)}>
                <Plus /> New conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" onClick={() => remember(null)} aria-label="New conversation" disabled={!data}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the assistant">
            <X />
          </Button>
        </div>
      </header>

      <div ref={scroller} className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {!data ? (
          <Welcome serverName={serverName} approval={status.approval} onPick={(t) => void send(t)} />
        ) : (
          data.items.map((item, i) => <Item key={i} item={item} onDecide={decide} />)
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Working…
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {serverName && (
          <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" /> About <span className="font-medium text-foreground">{serverName}</span>
          </p>
        )}
        <div className="relative">
          <Textarea
            ref={textarea}
            rows={2}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            placeholder={data?.status === "awaiting" ? "Approve or decline above, or say what to do instead…" : "Ask or tell the assistant what to do…"}
            className="max-h-40 min-h-[64px] resize-none pr-12"
            aria-label="Message to the assistant"
          />
          {data?.status === "running" ? (
            <Button type="button" size="icon-sm" variant="secondary" className="absolute bottom-2 right-2" onClick={() => void stop()} aria-label="Stop">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" className="absolute bottom-2 right-2" disabled={!draft.trim() || busy} aria-label="Send">
              <SendHorizontal />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          <Kbd>Enter</Kbd> to send · <Kbd>Ctrl I</Kbd> to open or close · Answers can be wrong; check before approving.
        </p>
      </form>
    </>
  );
}

function Welcome({ serverName, approval, onPick }: { serverName: string | null; approval: AssistantStatus["approval"]; onPick: (text: string) => void }) {
  const here = serverName ? "this server" : "my servers";
  const suggestions = serverName
    ? ["Why is this server lagging?", "Who is online, and who joined today?", "Back up this server", "Restart it every night at 4 am with a 60 second warning", "Which plugins are installed, and is one outdated?"]
    : ["Give me an overview of my servers", "Which server uses the most memory?", "Are any servers stopped that should run?"];
  return (
    <div className="space-y-5 pt-2">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">What should I do with {here}?</p>
        <p className="text-[13px] text-muted-foreground">
          I can check status and logs, manage players, backups, plugins, settings and schedules, with your permissions.{" "}
          {approval === "always" ? "Every change waits for your approval." : "Risky changes wait for your approval."}
        </p>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Item({ item, onDecide }: { item: AssistantItem; onDecide: (item: ToolItem, approve: boolean) => void }) {
  if (item.kind === "user")
    return <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-[13px]">{item.text}</div>;
  if (item.kind === "assistant") return <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{item.text}</div>;
  if (item.kind === "error")
    return (
      <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px]">
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span className="min-w-0 break-words">{item.text}</span>
      </div>
    );
  return <ToolCard item={item} onDecide={onDecide} />;
}

const STATE_ICON = {
  waiting: <Clock className="size-3.5 text-warning" />,
  running: <Loader2 className="size-3.5 animate-spin text-muted-foreground" />,
  done: <Check className="size-3.5 text-success" />,
  failed: <XCircle className="size-3.5 text-destructive" />,
  rejected: <CircleSlash className="size-3.5 text-muted-foreground" />,
} as const;

function ToolCard({ item, onDecide }: { item: ToolItem; onDecide: (item: ToolItem, approve: boolean) => void }) {
  const [open, setOpen] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);
  const waiting = item.state === "waiting";
  const decide = async (approve: boolean) => {
    setDeciding(true);
    await onDecide(item, approve);
    setDeciding(false);
  };
  return (
    <div className={cn("rounded-lg border text-[13px] transition-colors duration-200", waiting ? "border-warning/40 bg-warning/5" : "border-border bg-surface")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={open}>
        {STATE_ICON[item.state]}
        <span className={cn("min-w-0 flex-1 truncate", item.state === "rejected" && "text-muted-foreground line-through")}>{item.title}</span>
        {item.risk === "risky" && <Badge variant="warning">risky</Badge>}
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{item.result}</pre>}
        </div>
      )}
      {!open && item.state === "failed" && item.result && <p className="px-3 pb-2 text-xs text-destructive">{item.result}</p>}
      {waiting && (
        <div className="flex items-center gap-2 border-t border-warning/30 px-3 py-2">
          <span className="mr-auto text-xs text-muted-foreground">Waiting for your approval</span>
          <Button size="xs" variant="ghost" onClick={() => void decide(false)} disabled={deciding}>
            Decline
          </Button>
          <Button size="xs" onClick={() => void decide(true)} loading={deciding}>
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
