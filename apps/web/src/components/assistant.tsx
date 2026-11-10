"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  Check,
  ChevronDown,
  CircleSlash,
  Clock,
  Copy,
  History,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  SendHorizontal,
  ShieldAlert,
  Sparkles,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Kbd, Textarea } from "@craftpanel/ui";
import type { AssistantConversationView, AssistantItem, AssistantStatus } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useServers } from "@/lib/queries";
import { useRealtimeEvent } from "@/lib/realtime";
import { AssistantEmbed } from "./assistant-embeds";
import { Markdown } from "./markdown";

type ToolItem = Extract<AssistantItem, { kind: "tool" }>;
const STORAGE_KEY = "craftpanel.assistant.conversation";
const WIDE_KEY = "craftpanel.assistant.wide";

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
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    try {
      setWide(localStorage.getItem(WIDE_KEY) === "1");
    } catch {}
  }, []);
  const toggleWide = () =>
    setWide((w) => {
      try {
        localStorage.setItem(WIDE_KEY, w ? "0" : "1");
      } catch {}
      return !w;
    });

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
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
      {open && <div className="fixed inset-0 z-30 bg-black/20 duration-200 animate-in fade-in sm:hidden motion-reduce:animate-none" onClick={() => setOpen(false)} />}
      <aside
        role="dialog"
        aria-label="AI assistant"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-2xl transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          wide ? "sm:w-[min(720px,100vw)]" : "sm:w-[440px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <Panel status={status.data} open={open} wide={wide} onToggleWide={toggleWide} onClose={() => setOpen(false)} />
      </aside>
    </>
  );
}

function Panel({ status, open, wide, onToggleWide, onClose }: { status: AssistantStatus; open: boolean; wide: boolean; onToggleWide: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const params = useSearchParams();
  const pageServerId = pathname.startsWith("/server") ? params.get("id") : null;
  const servers = useServers();
  // The open server is the default context; the chip in the composer can drop it for a question about all servers.
  const [scoped, setScoped] = React.useState(true);
  React.useEffect(() => setScoped(true), [pageServerId]);
  const serverId = scoped ? pageServerId : null;
  const serverName = servers.data?.find((s) => s.id === pageServerId)?.name ?? null;

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
    // Changes arrive over the WebSocket as they happen; polling only covers a dropped connection.
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2500 : false),
  });
  useRealtimeEvent((msg) => {
    if (msg.type === "assistant") qc.setQueryData(["assistant-conversation", msg.conversation.id], msg.conversation);
  });
  // A conversation the panel no longer has (restart, expired): start fresh.
  React.useEffect(() => {
    if (conversation.error) remember(null);
  }, [conversation.error]);

  // When a run finishes, refresh what the dashboard shows: the assistant may have changed it.
  const lastStatus = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const s = conversation.data?.status;
    if (lastStatus.current === "running" && s !== "running") {
      void qc.invalidateQueries({ predicate: (q) => !String(q.queryKey[0]).startsWith("assistant") });
      void qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    }
    lastStatus.current = s;
  }, [conversation.data?.status, qc]);

  const history = useQuery({
    queryKey: ["assistant-conversations"],
    queryFn: () => api.get<{ id: string; title: string; status: string; updatedAt: number }[]>("/api/assistant/conversations"),
    enabled: open,
  });

  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState<string | null>(null);
  const data = conversation.data && conversation.data.id === conversationId ? conversation.data : undefined;
  const running = data?.status === "running";
  const busy = sending !== null || running;

  const setData = (v: AssistantConversationView) => qc.setQueryData(["assistant-conversation", v.id], v);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    // Show the question at once; the server's copy replaces it when it answers.
    setSending(message);
    setDraft("");
    try {
      const v = await api.post<AssistantConversationView>("/api/assistant/conversations", { message, serverId, conversationId: data ? data.id : undefined });
      setData(v);
      remember(v.id);
      void qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    } catch (err) {
      setDraft(message);
      toast.error(errorMessage(err));
    } finally {
      setSending(null);
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
  // The composer grows with the text, up to a few lines.
  React.useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  // Follow new messages while the reader is at the bottom; otherwise offer a jump back down.
  const scroller = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const toBottom = (behavior: ScrollBehavior = "smooth") => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior });
  const itemCount = data?.items.length ?? 0;
  const lastItem = data?.items.at(-1);
  React.useEffect(() => {
    // While an answer is being written, jump instead of gliding: a smooth scroll per update would lag behind.
    if (atBottom || sending) toBottom(lastItem?.kind === "assistant" && lastItem.streaming ? "instant" : "smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll on new content, not on scroll position changes
  }, [itemCount, data?.status, sending, lastItem && "state" in lastItem ? lastItem.state : null, lastItem?.kind === "assistant" ? lastItem.text.length : 0]);
  React.useEffect(() => {
    if (open) toBottom("instant");
  }, [open, conversationId]);

  // Items already there when a conversation opens appear at once; later ones slide in.
  const settled = React.useRef<{ id: string | null; count: number }>({ id: null, count: 0 });
  if (data && settled.current.id !== data.id) settled.current = { id: data.id, count: sending ? 0 : data.items.length };
  if (!data && !sending) settled.current = { id: null, count: 0 };
  const fresh = (index: number) => !!data && settled.current.id === data.id && index >= settled.current.count;

  const lastQuestion = [...(data?.items ?? [])].reverse().find((i) => i.kind === "user")?.text;
  const writing = lastItem?.kind === "assistant" && !!lastItem.streaming;
  const activeTool = data?.items.findLast((i): i is ToolItem => i.kind === "tool" && i.state === "running");
  const waitingCount = data?.items.filter((i) => i.kind === "tool" && i.state === "waiting").length ?? 0;
  const pastConversations = history.data ?? [];

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight">Assistant</p>
          <p className="truncate text-[11px] text-muted-foreground">{status.model}</p>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Earlier conversations" title="Earlier conversations">
                <History />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>Conversations</DropdownMenuLabel>
              {pastConversations.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => remember(c.id)} className="flex items-center gap-2">
                  <span className={cn("min-w-0 flex-1 truncate", c.id === conversationId && "font-medium")}>{c.title}</span>
                  {c.status === "awaiting" ? (
                    <Badge variant="warning">needs you</Badge>
                  ) : c.status === "running" ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(c.updatedAt)}</span>
                  )}
                </DropdownMenuItem>
              ))}
              {!pastConversations.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet. They are kept until CraftPanel restarts.</p>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => remember(null)}>
                <Plus /> New conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" onClick={() => remember(null)} aria-label="New conversation" title="New conversation" disabled={!data}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-sm" className="hidden sm:inline-flex" onClick={onToggleWide} aria-label={wide ? "Narrow panel" : "Wide panel"} title={wide ? "Narrow panel" : "Wide panel"}>
            {wide ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the assistant" title="Close (Esc)">
            <X />
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
          }}
          className="scrollbar-thin h-full overflow-y-auto"
          aria-live="polite"
        >
          <div className={cn("mx-auto space-y-4 px-4 py-5", wide && "max-w-[640px]")}>
            {!data && !sending ? (
              <Welcome serverName={serverId ? serverName : null} approval={status.approval} onPick={(t) => void send(t)} />
            ) : (
              <>
                {groupItems(data?.items ?? []).map((g) => (
                  <div key={g.start} className={cn(fresh(g.start) && !(g.kind === "item" && g.item.kind === "user") && "duration-300 ease-out animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none")}>
                    {g.kind === "steps" ? (
                      <StepGroup items={g.items} />
                    ) : (
                      <Item item={g.item} onDecide={decide} onRetry={lastQuestion && !busy ? () => void send(lastQuestion) : undefined} />
                    )}
                  </div>
                ))}
                {sending && (
                  <div className="duration-200 ease-out animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
                    <UserBubble text={sending} pending />
                  </div>
                )}
              </>
            )}
            {busy && data?.status !== "awaiting" && !writing && <Thinking label={activeTool ? activeTool.title : "Thinking…"} />}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => toBottom()}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface px-3 py-1 text-xs shadow-md transition-colors duration-200 animate-in fade-in slide-in-from-bottom-1 hover:bg-muted motion-reduce:animate-none"
          >
            <ArrowDown className="size-3.5" /> Latest
          </button>
        )}
      </div>

      <form
        className="shrink-0 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <div className={cn("mx-auto", wide && "max-w-[640px]")}>
          {waitingCount > 0 && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-warning duration-200 animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none">
              <ShieldAlert className="size-3.5" /> {waitingCount === 1 ? "A change waits for your approval above." : `${waitingCount} changes wait for your approval above.`}
            </p>
          )}
          <div className="rounded-lg border border-border bg-surface shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
            <Textarea
              ref={textarea}
              rows={1}
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              placeholder={data?.status === "awaiting" ? "Or say what to do instead…" : data ? "Reply…" : "Ask or tell the assistant what to do…"}
              className="max-h-[168px] min-h-[44px] resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
              aria-label="Message to the assistant"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              {pageServerId && serverName && (
                <button
                  type="button"
                  onClick={() => setScoped((s) => !s)}
                  aria-pressed={scoped}
                  title={scoped ? "Questions are about this server. Click to ask about all servers." : "Questions are about all servers. Click to ask about this one."}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                    scoped ? "border-border bg-muted text-foreground" : "border-dashed border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", scoped ? "bg-success" : "bg-muted-foreground/50")} />
                  <span className="truncate">{scoped ? serverName : "All servers"}</span>
                  {scoped && <X className="size-3 shrink-0 text-muted-foreground" />}
                </button>
              )}
              <span className="flex-1" />
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> new line
              </span>
              {running ? (
                <Button type="button" size="icon-sm" variant="secondary" onClick={() => void stop()} aria-label="Stop" title="Stop">
                  <Square className="fill-current" />
                </Button>
              ) : (
                <Button type="submit" size="icon-sm" disabled={!draft.trim() || busy} aria-label="Send" title="Send (Enter)">
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </div>
        </div>
      </form>
    </>
  );
}

type Group = ({ kind: "item"; item: AssistantItem } | { kind: "steps"; items: ToolItem[] }) & { start: number };

/**
 * Runs of finished or running tool calls collapse into one "steps" row; waiting calls stay cards of their own,
 * and a shown live card is drawn as the card itself.
 */
function groupItems(items: AssistantItem[]): Group[] {
  const out: Group[] = [];
  items.forEach((item, start) => {
    const last = out.at(-1);
    if (item.kind === "tool" && item.state !== "waiting" && !(item.embed && item.state === "done")) {
      if (last?.kind === "steps") last.items.push(item);
      else out.push({ kind: "steps", items: [item], start });
    } else out.push({ kind: "item", item, start });
  });
  return out;
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground duration-300 animate-in fade-in motion-reduce:animate-none">
      <span className="cp-dots flex gap-1" aria-hidden>
        <span className="size-1.5 rounded-full bg-muted-foreground" />
        <span className="size-1.5 rounded-full bg-muted-foreground" />
        <span className="size-1.5 rounded-full bg-muted-foreground" />
      </span>
      <span key={label} className="truncate duration-200 animate-in fade-in motion-reduce:animate-none">
        {label}
      </span>
    </div>
  );
}

function Welcome({ serverName, approval, onPick }: { serverName: string | null; approval: AssistantStatus["approval"]; onPick: (text: string) => void }) {
  const suggestions = serverName
    ? ["Why is this server lagging?", "Who is online, and who joined today?", "Back up this server", "Restart it every night at 4 am with a 60 second warning", "Which plugins are installed, and is one outdated?"]
    : ["Give me an overview of my servers", "Which server uses the most memory?", "Are any servers stopped that should run?"];
  return (
    <div className="space-y-5 pt-1">
      <div className="space-y-1.5">
        <p className="text-base font-medium">{serverName ? <>What should I do with {serverName}?</> : "What should I do?"}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          I check status, performance and the console, and manage players, backups, plugins, settings and schedules, with your permissions.{" "}
          {approval === "always" ? "Every change waits for your approval." : "Risky changes wait for your approval."} Answers can be wrong, so read a change before you approve it.
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Try</p>
        <div className="flex flex-col items-stretch gap-1.5">
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
              className="group flex items-center gap-2 duration-300 ease-out animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none rounded-lg border border-border bg-surface px-3 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]"
            >
              <span className="flex-1">{s}</span>
              <SendHorizontal className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text, pending }: { text: string; pending?: boolean }) {
  return <div className={cn("ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[13px]", pending && "opacity-70")}>{text}</div>;
}

function Item({ item, onDecide, onRetry }: { item: AssistantItem; onDecide: (item: ToolItem, approve: boolean) => void; onRetry?: () => void }) {
  if (item.kind === "user") return <UserBubble text={item.text} />;
  if (item.kind === "assistant") return <Answer text={item.text} writing={!!item.streaming} />;
  if (item.kind === "tool" && item.embed && item.state === "done") return <AssistantEmbed embed={item.embed} />;
  if (item.kind === "error")
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px]">
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 break-words">{item.text}</span>
        {onRetry && (
          <Button size="xs" variant="ghost" onClick={onRetry} className="-my-0.5 shrink-0">
            <RotateCcw /> Retry
          </Button>
        )}
      </div>
    );
  return <ApprovalCard item={item} onDecide={onDecide} />;
}

function Answer({ text, writing }: { text: string; writing: boolean }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="group/answer relative text-[13px] leading-relaxed">
      <Markdown text={text} className={cn(writing && "cp-writing")} />
      {!writing && <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
        className="absolute -top-1 right-0 flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/answer:opacity-100"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
      </button>}
    </div>
  );
}

const STATE_ICON = {
  waiting: <Clock className="size-3.5 shrink-0 text-warning" />,
  running: <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />,
  done: <Check className="size-3.5 shrink-0 text-success" />,
  failed: <XCircle className="size-3.5 shrink-0 text-destructive" />,
  rejected: <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />,
} as const;

/** What the assistant did, folded into one line: "Checked 3 things", with each step and its details on demand. */
function StepGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = React.useState(false);
  const running = items.find((i) => i.state === "running");
  const failed = items.filter((i) => i.state === "failed").length;
  const declined = items.filter((i) => i.state === "rejected").length;
  const changed = items.filter((i) => i.risk !== "read" && i.state === "done").length;
  const checked = items.length - changed - declined;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // A single step reads better as itself than as "1 step".
  const summary = running
    ? running.title
    : items.length === 1
      ? items[0].title
      : [changed && `made ${plural(changed, "change")}`, checked && `checked ${plural(checked, "thing")}`, declined && `${declined} declined`]
          .filter(Boolean)
          .join(", ")
          .replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {running ? STATE_ICON.running : failed ? STATE_ICON.failed : declined && items.length === 1 ? STATE_ICON.rejected : STATE_ICON.done}
        <span className={cn("min-w-0 truncate", items.length === 1 && items[0].state === "rejected" && "line-through")}>{summary}</span>
        {failed > 0 && items.length > 1 && <Badge variant="danger">{failed} failed</Badge>}
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {!open && items.length === 1 && items[0].state === "failed" && items[0].result && <p className="pl-5.5 text-xs text-destructive">{items[0].result}</p>}
      <Collapse open={open}>
        <ol className="mt-1 space-y-1 border-l border-border pl-3">
          {items.map((t) => (
            <Step key={t.id} item={t} defaultOpen={items.length === 1} />
          ))}
        </ol>
      </Collapse>
    </div>
  );
}

function Step({ item, defaultOpen }: { item: ToolItem; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <li>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 py-0.5 text-left text-[12px] hover:text-foreground">
        {STATE_ICON[item.state]}
        <span className={cn("min-w-0 flex-1 truncate", item.state === "rejected" && "text-muted-foreground line-through")}>{item.title}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{item.name}</span>
      </button>
      <Collapse open={open}>
        <Details item={item} />
      </Collapse>
    </li>
  );
}

/** Opens and closes its content by height, without measuring (grid rows from 0fr to 1fr). */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} inert={!open}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** The call's input as label/value pairs and its result, as sent to and returned from CraftPanel. */
function Details({ item }: { item: ToolItem }) {
  // The server is already named in the title; its id would only add noise.
  const entries = Object.entries(item.input).filter(([k]) => k !== "serverId");
  return (
    <div className="mb-1 mt-1 space-y-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[11px]">
      {entries.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {entries.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words font-mono">
                {v && typeof v === "object" && !Array.isArray(v)
                  ? Object.entries(v).map(([sk, sv]) => (
                      <span key={sk} className="block">
                        {sk} = {typeof sv === "string" ? sv : JSON.stringify(sv)}
                      </span>
                    ))
                  : typeof v === "string"
                    ? v
                    : JSON.stringify(v)}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {item.result && <pre className={cn("scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono", entries.length > 0 && "border-t border-border pt-2", item.state === "failed" && "text-destructive")}>{item.result}</pre>}
      {!entries.length && !item.result && <p className="text-muted-foreground">No details.</p>}
    </div>
  );
}

/** A change that waits: what will happen, with what, and the two buttons. */
function ApprovalCard({ item, onDecide }: { item: ToolItem; onDecide: (item: ToolItem, approve: boolean) => void }) {
  const [deciding, setDeciding] = React.useState<null | "yes" | "no">(null);
  const decide = async (approve: boolean) => {
    setDeciding(approve ? "yes" : "no");
    await onDecide(item, approve);
    setDeciding(null);
  };
  const risky = item.risk === "risky";
  return (
    <div className={cn("overflow-hidden rounded-lg border text-[13px] shadow-xs", risky ? "border-destructive/40" : "border-warning/50")}>
      <div className={cn("flex items-center gap-2 px-3 py-2 text-xs font-medium", risky ? "bg-destructive/8 text-destructive" : "bg-warning/10 text-warning")}>
        <ShieldAlert className="size-3.5" />
        {risky ? "Risky change: approve?" : "Approve this change?"}
      </div>
      <div className="space-y-2 bg-surface px-3 py-2.5">
        <p className="font-medium">{item.title}</p>
        <Details item={item} />
        <div className="flex items-center justify-end gap-2 pt-0.5">
          <Button size="sm" variant="ghost" onClick={() => void decide(false)} disabled={deciding !== null} loading={deciding === "no"}>
            Decline
          </Button>
          <Button size="sm" variant={risky ? "destructive" : "default"} onClick={() => void decide(true)} disabled={deciding !== null} loading={deciding === "yes"}>
            <Check /> Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
