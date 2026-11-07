"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { Command } from "cmdk";
import { Activity, Archive, Boxes, ChevronsUpDown, LayoutGrid, LogOut, Menu, Monitor, Moon, Plus, Search, Settings, Sun, Server as ServerIcon, KeyRound, X } from "lucide-react";
import { Button, cn, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Kbd, Skeleton } from "@craftpanel/ui";
import { ROLE_LABELS } from "@craftpanel/shared";
import { useAuth, useCan } from "@/lib/auth";
import { api, setCsrfToken } from "@/lib/api";
import { RealtimeProvider, useConnectionState } from "@/lib/realtime";
import { useServers } from "@/lib/queries";
import { StatusDot } from "./status";
import { Logo } from "./logo";
import { UpdateNotice } from "./updates";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/servers/", label: "Servers", icon: Boxes },
  { href: "/activity/", label: "Activity", icon: Activity },
  { href: "/backups/", label: "Backups", icon: Archive },
  { href: "/settings/", label: "Settings", icon: Settings },
];

/** Authenticated application frame. Redirects to setup/login when needed. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense fallback={null}>
      <AuthGate>{children}</AuthGate>
    </React.Suspense>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { state, loading, error } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!state) return;
    if (state.setupRequired) router.replace("/setup/");
    else if (!state.user) router.replace("/login/");
  }, [state, router]);

  if (error && !state)
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div className="space-y-2">
          <p className="font-medium">Cannot reach the CraftPanel service</p>
          <p className="text-sm text-muted-foreground">Make sure CraftPanel is running, then reload this page.</p>
          <Button variant="secondary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  if (loading || !state?.user)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Logo className="size-8 animate-pulse text-muted-foreground" />
      </div>
    );

  return (
    <RealtimeProvider enabled>
      <Frame>{children}</Frame>
    </RealtimeProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const pathname = usePathname();

  React.useEffect(() => setMobileOpen(false), [pathname]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-background transition-transform lg:translate-x-0", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
        <Sidebar onSearch={() => setPaletteOpen(true)} />
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen((o) => !o)} aria-label="Toggle navigation">
            {mobileOpen ? <X /> : <Menu />}
          </Button>
          <Logo className="size-5" />
          <span className="text-sm font-semibold">CraftPanel</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setPaletteOpen(true)} aria-label="Search">
            <Search />
          </Button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const activeServer = pathname.startsWith("/server") ? params.get("id") : null;
  const servers = useServers();
  const connection = useConnectionState();
  const canCreate = useCan("server.create");

  return (
    <>
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo className="size-6" />
        <span className="text-[15px] font-semibold tracking-tight">CraftPanel</span>
        <span
          className={cn("ml-auto size-1.5 rounded-full", connection === "open" ? "bg-success" : connection === "connecting" ? "bg-warning animate-pulse" : "bg-destructive")}
          title={connection === "open" ? "Live updates connected" : connection === "connecting" ? "Connecting…" : "Disconnected — reconnecting"}
        />
      </div>
      <div className="px-3 pb-2">
        <button
          onClick={onSearch}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="size-3.5" />
          Search…
          <Kbd className="ml-auto">Ctrl K</Kbd>
        </button>
      </div>
      <nav className="space-y-0.5 px-3 py-2" aria-label="Primary">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href.replace(/\/$/, "")) && !(item.href === "/servers/" && pathname.startsWith("/server/"));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active || (item.href === "/servers/" && pathname.startsWith("/server")) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-3 flex items-center justify-between px-5 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Servers</span>
        {canCreate && (
          <Link href="/servers/new/" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="New server">
            <Plus className="size-3.5" />
          </Link>
        )}
      </div>
      <div className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {servers.isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-8" />)}
        {servers.data?.map((s) => (
          <Link
            key={s.id}
            href={`/server/?id=${s.id}`}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeServer === s.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <StatusDot status={s.status} />
            <span className="truncate">{s.name}</span>
            {s.status === "running" && <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{s.playersOnline}</span>}
          </Link>
        ))}
        {servers.data?.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">No servers yet</p>}
      </div>
      <UpdateNotice />
      <UserMenu />
    </>
  );
}

function UserMenu() {
  const { state, refresh } = useAuth();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const user = state!.user!;
  return (
    <div className="border-t border-border p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex size-7 items-center justify-center rounded-full bg-foreground text-xs font-semibold uppercase text-background">{user.username.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{user.username}</span>
              <span className="block text-[11px] text-muted-foreground">{ROLE_LABELS[user.role]}</span>
            </span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {[
            ["light", "Light", Sun],
            ["dark", "Dark", Moon],
            ["system", "System", Monitor],
          ].map(([value, label, Icon]) => {
            const I = Icon as typeof Sun;
            return (
              <DropdownMenuItem key={value as string} onSelect={() => setTheme(value as string)}>
                <I />
                {label as string}
                {theme === value && <span className="ml-auto size-1.5 rounded-full bg-foreground" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push("/settings/?tab=account")}>
            <KeyRound />
            Account & password
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              await api.post("/api/auth/logout").catch(() => undefined);
              setCsrfToken(null);
              await refresh();
              router.replace("/login/");
            }}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const SERVER_TABS = ["overview", "console", "players", "worlds", "plugins", "files", "backups", "automation", "settings", "network"];

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const servers = useServers();
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const item = "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        <Command label="Command palette" className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 text-muted-foreground" />
            <Command.Input autoFocus placeholder="Jump to a server, page or action…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <Command.List className="scrollbar-thin max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">No results.</Command.Empty>
            <Command.Group heading="Navigate" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
              {NAV.map((n) => (
                <Command.Item key={n.href} onSelect={() => go(n.href)} className={item}>
                  <n.icon />
                  {n.label}
                </Command.Item>
              ))}
              <Command.Item onSelect={() => go("/servers/new/")} className={item}>
                <Plus />
                Create server
              </Command.Item>
            </Command.Group>
            {!!servers.data?.length && (
              <Command.Group heading="Servers" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
                {servers.data.flatMap((s) => [
                  <Command.Item key={s.id} value={`${s.name} server`} onSelect={() => go(`/server/?id=${s.id}`)} className={item}>
                    <ServerIcon />
                    {s.name}
                    <StatusDot status={s.status} className="ml-auto" />
                  </Command.Item>,
                  ...SERVER_TABS.slice(1).map((t) => (
                    <Command.Item key={s.id + t} value={`${s.name} ${t}`} onSelect={() => go(`/server/?id=${s.id}&tab=${t}`)} className={cn(item, "pl-9")}>
                      <span className="capitalize">{t}</span>
                      <span className="text-muted-foreground">— {s.name}</span>
                    </Command.Item>
                  )),
                ])}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
