"use client";

import * as React from "react";
import { Panel, Tooltip, cn } from "@craftpanel/ui";
import { APP_LOCALE, prettyId, type ItemStack } from "@craftpanel/shared";
import { API_BASE } from "@/lib/api";
import { formatPlaytime } from "@/lib/format";
import { WEEKDAYS } from "@/lib/player-insights";

/** A titled panel; the one container every player view uses. */
export function Card({ title, hint, aside, className, children }: { title: React.ReactNode; hint?: React.ReactNode; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <Panel className={cn("p-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium">{title}</h3>
        {aside && <div className="truncate text-xs tabular-nums text-muted-foreground">{aside}</div>}
      </div>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </Panel>
  );
}

/** Key figures in one frame with 1 px dividers (the website's datasheet look). */
export function KpiGrid({ items }: { items: { label: string; value: React.ReactNode; sub?: React.ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 space-y-1 bg-surface p-4">
          <div className="text-xs font-medium text-muted-foreground">{i.label}</div>
          <div className="truncate font-mono text-xl font-medium tabular-nums tracking-tight">{i.value}</div>
          <div className="min-h-4 truncate text-xs text-muted-foreground">{i.sub}</div>
        </div>
      ))}
    </div>
  );
}

const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(APP_LOCALE, { weekday: "short", day: "numeric", month: "short" });

/** Playtime per day as columns; the readout under the chart follows the pointer. */
export function DailyBars({ days }: { days: { day: string; ms: number }[] }) {
  const [hover, setHover] = React.useState<number | null>(null);
  // A floor, so a few seconds of play don't fill the whole chart.
  const max = Math.max(10 * 60_000, ...days.map((d) => d.ms));
  const total = days.reduce((n, d) => n + d.ms, 0);
  const shown = hover === null ? null : days[hover];
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">{shown ? `${dayLabel(shown.day)} · ${shown.ms ? formatPlaytime(shown.ms) : "not online"}` : `Last 30 days · ${formatPlaytime(total)} in total`}</span>
        <span className="font-mono text-[10px]">{formatPlaytime(max)}</span>
      </div>
      <div
        className="mt-2 flex h-24 items-end gap-[3px] border-b border-border"
        role="img"
        aria-label={`Playtime per day over the last 30 days: ${formatPlaytime(total)} in total, ${days.filter((d) => d.ms > 0).length} days with play`}
        onPointerLeave={() => setHover(null)}
      >
        {days.map((d, i) => (
          <div key={d.day} className="flex h-full flex-1 items-end" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
            <div className={cn("w-full rounded-t-[2px]", d.ms ? "bg-foreground" : "bg-muted", hover === i && d.ms ? "opacity-70" : "")} style={{ height: d.ms ? `${Math.max(4, (d.ms / max) * 100)}%` : "2px" }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{new Date(`${days[0]?.day}T12:00:00`).toLocaleDateString(APP_LOCALE, { day: "numeric", month: "short" })}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** When the player is online: weekday by hour, darker is more time. */
export function Heatmap({ heat }: { heat: number[][] }) {
  const [hover, setHover] = React.useState<{ d: number; h: number } | null>(null);
  const max = Math.max(1, ...heat.flat());
  const shown = hover ? heat[hover.d]?.[hover.h] : null;
  return (
    <div>
      <p className="h-4 text-xs tabular-nums text-muted-foreground">
        {hover ? `${WEEKDAYS[hover.d]}, ${String(hover.h).padStart(2, "0")}:00–${String(hover.h + 1).padStart(2, "0")}:00 · ${shown ? formatPlaytime(shown) : "never online"}` : "Total time online by weekday and hour of day"}
      </p>
      <div className="mt-2 grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] gap-[2px]" role="img" aria-label="Heatmap of playtime by weekday and hour of day" onPointerLeave={() => setHover(null)}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center font-mono text-[9px] text-muted-foreground">
            {h % 6 === 0 ? h : ""}
          </span>
        ))}
        {heat.map((hours, d) => (
          <React.Fragment key={d}>
            <span className="self-center font-mono text-[10px] text-muted-foreground">{WEEKDAYS[d].slice(0, 3)}</span>
            {hours.map((ms, h) => (
              <span
                key={h}
                className={cn("aspect-square rounded-[2px]", ms ? "" : "bg-muted/60", hover?.d === d && hover.h === h && "ring-1 ring-foreground")}
                style={ms ? { background: `color-mix(in oklch, var(--foreground) ${Math.round(12 + (ms / max) * 76)}%, transparent)` } : undefined}
                onPointerEnter={() => setHover({ d, h })}
                onPointerDown={() => setHover({ d, h })}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/** A ranked list with a bar behind each value, scaled to the first entry. */
export function BarList({ items, empty = "Nothing recorded yet.", tone = "bg-foreground" }: { items: { label: string; value: number; display?: string; icon?: string }[]; empty?: string; tone?: string }) {
  if (!items.length) return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              {i.icon && (
                <span className="size-5 shrink-0">
                  <ItemFace id={i.icon} className="rounded-[2px] text-[8px]" />
                </span>
              )}
              <span className="truncate">{i.label}</span>
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{i.display ?? i.value.toLocaleString(APP_LOCALE)}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- vitals ---------------------------------------------------------------------------------------

const HEART = ["..XX.XX..", ".XXXXXXX.", ".XXXXXXX.", "..XXXXX..", "...XXX...", "....X...."];

function Heart({ fill }: { fill: 0 | 0.5 | 1 }) {
  const shape = (cls: string) => (
    <svg viewBox="0 0 9 6" width="18" height="12" shapeRendering="crispEdges" className={cls} aria-hidden>
      {HEART.flatMap((row, y) => [...row].map((c, x) => (c === "X" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" /> : null)))}
    </svg>
  );
  return (
    <span className="relative block h-3 w-[18px]">
      {shape("absolute inset-0 text-muted")}
      {fill > 0 && <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>{shape("text-destructive")}</span>}
    </span>
  );
}

export function Hearts({ health, max = 20 }: { health: number; max?: number }) {
  const hearts = Math.max(10, Math.ceil(max / 2));
  return (
    <div className="flex flex-wrap gap-0.5" role="img" aria-label={`Health ${health} of ${max}`}>
      {Array.from({ length: hearts }, (_, i) => (
        <Heart key={i} fill={health >= (i + 1) * 2 ? 1 : health > i * 2 ? 0.5 : 0} />
      ))}
    </div>
  );
}

export function Pips({ value, max = 20, className }: { value: number; max?: number; className?: string }) {
  return (
    <div className="flex gap-0.5" role="img" aria-label={`${value} of ${max}`}>
      {Array.from({ length: max / 2 }, (_, i) => (
        <span key={i} className="relative block size-3 overflow-hidden rounded-[2px] bg-muted">
          <span className={cn("absolute inset-y-0 left-0", className)} style={{ width: value >= (i + 1) * 2 ? "100%" : value > i * 2 ? "50%" : "0%" }} />
        </span>
      ))}
    </div>
  );
}

// ---- items ----------------------------------------------------------------------------------------

/** The server whose item textures the slots below load; set once around a profile. */
const ItemIconsContext = React.createContext<string | null>(null);
export const ItemIconsProvider = ItemIconsContext.Provider;

function itemHue(id: string): number {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const roman = (n: number) => ROMAN[n] ?? String(n);

/** Two letters that tell items apart at a glance: first letters of the first and last word. */
function monogram(id: string): string {
  const words = prettyId(id).replace(/\(.*\)/, "").trim().split(/\s+/);
  return words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
}

/** Grey textures that the game colours by biome; a plains-like green stands in for the biome. */
function tintOf(name: string): string | null {
  if (name === "spruce_leaves") return "#619961";
  if (name === "birch_leaves") return "#80a755";
  if (/^(oak|jungle|acacia|dark_oak|mangrove)_leaves$/.test(name) || ["grass_block", "short_grass", "tall_grass", "fern", "large_fern", "vine"].includes(name)) return "#78b050";
  return null;
}

const pixelated = { imageRendering: "pixelated" } as const;

/**
 * An item's picture, filling its parent: Mojang's texture when this server's version has one (loaded from the
 * dashboard's own API, which fetched it from Mojang), otherwise a coloured tile with a monogram. Animated textures
 * are strips of frames; the first frame is shown.
 */
export function ItemFace({ id, className }: { id: string; className?: string }) {
  const serverId = React.useContext(ItemIconsContext);
  const [failed, setFailed] = React.useState(false);
  const name = id.startsWith("minecraft:") ? id.slice(10) : null;
  if (!serverId || !name || failed)
    return (
      <span className={cn("grid size-full place-items-center rounded-[3px] font-mono text-[11px] font-medium uppercase text-white/90", className)} style={{ background: `hsl(${itemHue(id)} 36% 38%)` }}>
        {monogram(id)}
      </span>
    );
  const src = `${API_BASE}/api/servers/${serverId}/item-icons/${name}`;
  const tint = tintOf(name);
  return (
    <span className={cn("relative block size-full", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" draggable={false} onError={() => setFailed(true)} className="size-full object-cover object-top" style={pixelated} />
      {tint && <span className="absolute inset-0" style={{ background: tint, mixBlendMode: "multiply", WebkitMaskImage: `url(${src})`, maskImage: `url(${src})`, maskSize: "cover", maskPosition: "top", ...pixelated }} />}
    </span>
  );
}

/**
 * One inventory slot; the tooltip has the real name, enchantments and wear. `ghost` names an empty slot that has a
 * fixed purpose (armor, offhand).
 */
export function ItemSlot({ item, selected, label, ghost }: { item: ItemStack | null; selected?: boolean; label?: string; ghost?: string }) {
  const frame = cn("relative aspect-square min-w-0 rounded-md border bg-muted/40", selected ? "border-foreground ring-1 ring-foreground" : "border-border");
  if (!item)
    return (
      <div className={frame} aria-label={label ? `${label}: empty` : "Empty slot"} title={label}>
        {ghost && <span className="absolute inset-0 grid place-items-center text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">{ghost}</span>}
      </div>
    );
  const name = item.name ?? prettyId(item.id);
  return (
    <Tooltip
      content={
        <div className="space-y-0.5">
          <p className="font-medium">{name}</p>
          {item.name && <p className="opacity-70">{prettyId(item.id)}</p>}
          {item.enchantments?.map((e) => (
            <p key={e.id} className="opacity-80">
              {prettyId(e.id)} {roman(e.level)}
            </p>
          ))}
          {item.damage ? <p className="opacity-70">Worn: {item.damage} durability used</p> : null}
          <p className="font-mono text-[10px] opacity-60">{item.id}</p>
        </div>
      }
    >
      <div className={cn(frame, "p-[3px]")} aria-label={`${label ? `${label}: ` : ""}${item.count > 1 ? `${item.count} × ` : ""}${name}`} tabIndex={0}>
        <ItemFace id={item.id} />
        {item.count > 1 && <span className="absolute bottom-0.5 right-1 font-mono text-[10px] font-medium tabular-nums text-white [text-shadow:0_0_2px_#000,0_0_2px_#000]">{item.count}</span>}
        {item.enchantments?.length ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-brand ring-1 ring-black/40" /> : null}
      </div>
    </Tooltip>
  );
}

/** A rows × 9 block of slots from `first`, in Minecraft's slot order. */
export function SlotGrid({ items, first, rows, selected, label }: { items: ItemStack[]; first: number; rows: number; selected?: number | null; label: string }) {
  const bySlot = React.useMemo(() => new Map(items.map((i) => [i.slot, i])), [items]);
  return (
    <div className="grid grid-cols-9 gap-1.5">
      {Array.from({ length: rows * 9 }, (_, i) => (
        <ItemSlot key={first + i} item={bySlot.get(first + i) ?? null} selected={selected === first + i} label={`${label} ${i + 1}`} />
      ))}
    </div>
  );
}
