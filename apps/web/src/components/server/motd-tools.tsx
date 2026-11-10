"use client";

import * as React from "react";
import { Button, SegmentedControl, Tooltip, cn } from "@craftpanel/ui";
import { MOTD_COLORS, MOTD_EFFECTS, MOTD_FORMATS, type MotdFormatKey } from "@craftpanel/shared";
import { MOTD_SYMBOL_GROUPS, PIXEL_CANVAS, pixelCells, type PixelSymbol } from "@/lib/motd-pixels";
import { MotdText } from "./motd-preview";

const gradientCss = (stops: readonly string[]) => `linear-gradient(90deg, ${stops.join(", ")})`;
/** Keep the text selection in the message while a button is pressed. */
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/** The strip on top of the message field: the sixteen colours as Minecraft's chat colour chart, the styles and Clear. */
export function ColourStyleBar({ canEdit, onColor, onToggle, onClear }: { canEdit: boolean; onColor: (code: string) => void; onToggle: (key: MotdFormatKey, code: string) => void; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-3 py-2.5">
      <div role="group" aria-label="Colours" className="grid grid-cols-8 gap-1">
        {MOTD_COLORS.map((c) => (
          <Tooltip key={c.code} content={`${c.name} (§${c.code})`}>
            <button
              type="button"
              disabled={!canEdit}
              aria-label={c.name}
              onMouseDown={keepSelection}
              onClick={() => onColor(c.code)}
              className="size-6 rounded-[4px] border border-foreground/15 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: c.hex }}
            />
          </Tooltip>
        ))}
      </div>
      <span aria-hidden className="hidden h-9 w-px bg-border sm:block" />
      <div role="group" aria-label="Styles" className="flex items-center gap-1">
        {MOTD_FORMATS.map((f) => (
          <Tooltip key={f.code} content={`${f.name} (§${f.code})`}>
            <Button type="button" variant="secondary" size="icon-sm" disabled={!canEdit} aria-label={f.name} onMouseDown={keepSelection} onClick={() => onToggle(f.key, f.code)}>
              <span
                aria-hidden
                className={cn("text-[13px]", f.key === "bold" && "font-bold", f.key === "italic" && "italic", f.key === "underline" && "underline", f.key === "strike" && "line-through", f.key === "obfuscated" && "font-mono tracking-tighter")}
              >
                {f.key === "obfuscated" ? "?!" : f.name[0]}
              </span>
            </Button>
          </Tooltip>
        ))}
      </div>
      <Tooltip content="Remove colours and styles from the selection, or from everything if nothing is selected">
        <Button type="button" variant="ghost" size="sm" disabled={!canEdit} onMouseDown={keepSelection} onClick={onClear} className="ml-auto">
          Clear
        </Button>
      </Tooltip>
    </div>
  );
}

type ToolTab = "effects" | "symbols" | "examples";

export interface MotdExample {
  id: string;
  label: string;
  text: string;
}

/** The things that go into a message besides plain colours: gradients, symbols and whole examples, one panel at a time. */
export function MotdTools({
  canEdit,
  smooth,
  onSmooth,
  hexServer,
  onPaint,
  onSymbol,
  examples,
  onExample,
}: {
  canEdit: boolean;
  smooth: boolean;
  onSmooth: (smooth: boolean) => void;
  /** The server software shows smooth colours (Paper, Purpur); Vanilla, Fabric and NeoForge do not. */
  hexServer: boolean;
  onPaint: (stops: readonly string[]) => void;
  onSymbol: (symbol: string) => void;
  examples: MotdExample[];
  onExample: (text: string) => void;
}) {
  const [tab, setTab] = React.useState<ToolTab>("effects");
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <SegmentedControl
          aria-label="Message tools"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "effects", label: "Colour effects" },
            { value: "symbols", label: "Symbols" },
            { value: "examples", label: "Examples" },
          ]}
        />
        {tab !== "symbols" && (
          <SegmentedControl
            aria-label="Colour mode"
            value={smooth ? "smooth" : "classic"}
            onValueChange={(v) => onSmooth(v === "smooth")}
            options={[
              { value: "smooth", label: "Smooth colours" },
              { value: "classic", label: "16 classic colours" },
            ]}
          />
        )}
      </div>
      <div className="p-3">
        {tab === "effects" && <EffectsPanel canEdit={canEdit} onPaint={onPaint} />}
        {tab === "symbols" && <SymbolsPanel canEdit={canEdit} onPick={onSymbol} />}
        {tab === "examples" && <ExamplesPanel canEdit={canEdit} examples={examples} onPick={onExample} />}
      </div>
      {tab !== "symbols" && (
        <p className={cn("border-t border-border px-3 py-2 text-xs", smooth && !hexServer ? "text-warning" : "text-muted-foreground")}>
          {smooth
            ? hexServer
              ? "Smooth colours show in full on Paper and Purpur. Each coloured letter takes 14 characters."
              : "This server's software can't show smooth colours; players would see wrong ones. Use the 16 classic colours, or switch to Paper."
            : "Classic mode picks the nearest of the game's 16 colours for each letter, so it works on every server."}
        </p>
      )}
    </div>
  );
}

function EffectsPanel({ canEdit, onPaint }: { canEdit: boolean; onPaint: (stops: readonly string[]) => void }) {
  const [from, setFrom] = React.useState("#ff7a18");
  const [to, setTo] = React.useState("#8e2de2");
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">Spreads a gradient over the selected text, or over the whole message if nothing is selected.</p>
      <div role="group" aria-label="Effects" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {MOTD_EFFECTS.map((e) => (
          <button
            key={e.id}
            type="button"
            disabled={!canEdit}
            onMouseDown={keepSelection}
            onClick={() => onPaint(e.stops)}
            className="flex flex-col gap-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-left text-[13px] outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>{e.name}</span>
            <span aria-hidden className="h-1.5 w-full rounded-full" style={{ backgroundImage: gradientCss(e.stops) }} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-3 py-2">
        <span className="text-[13px] font-medium">Your own</span>
        <input type="color" aria-label="Gradient start colour" value={from} disabled={!canEdit} onChange={(e) => setFrom(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50" />
        <span aria-hidden className="h-1.5 w-12 rounded-full" style={{ backgroundImage: gradientCss([from, to]) }} />
        <input type="color" aria-label="Gradient end colour" value={to} disabled={!canEdit} onChange={(e) => setTo(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50" />
        <Button type="button" variant="secondary" size="sm" disabled={!canEdit} onMouseDown={keepSelection} onClick={() => onPaint([from, to])} className="ml-auto">
          Apply gradient
        </Button>
      </div>
    </div>
  );
}

/** A symbol's picture: pixel art at three screen pixels per art pixel, crisp at every zoom. */
export function PixelGlyph({ symbol, className }: { symbol: PixelSymbol; className?: string }) {
  return (
    <svg viewBox={`0 0 ${PIXEL_CANVAS} ${PIXEL_CANVAS}`} width={PIXEL_CANVAS * 3} height={PIXEL_CANVAS * 3} shapeRendering="crispEdges" className={className} aria-hidden>
      {pixelCells(symbol).map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" fill={c.color} />
      ))}
    </svg>
  );
}

function SymbolsPanel({ canEdit, onPick }: { canEdit: boolean; onPick: (symbol: string) => void }) {
  const [group, setGroup] = React.useState(MOTD_SYMBOL_GROUPS[0].id);
  const current = MOTD_SYMBOL_GROUPS.find((g) => g.id === group) ?? MOTD_SYMBOL_GROUPS[0];
  return (
    <div className="space-y-3">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <SegmentedControl aria-label="Symbol group" value={group} onValueChange={setGroup} options={MOTD_SYMBOL_GROUPS.map((g) => ({ value: g.id, label: g.label }))} />
      </div>
      <div role="group" aria-label={current.label} className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1.5">
        {current.symbols.map((symbol) => (
          <Tooltip key={symbol.ch} content={`${symbol.name}  ${symbol.ch}`}>
            <button
              type="button"
              disabled={!canEdit}
              aria-label={`Insert ${symbol.name}`}
              onMouseDown={keepSelection}
              onClick={() => onPick(symbol.ch)}
              className="group grid aspect-square place-items-center rounded-md border border-border bg-muted/40 outline-none transition-colors hover:border-foreground/60 hover:bg-muted dark:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PixelGlyph symbol={symbol} className="transition-transform group-hover:-translate-y-px" />
            </button>
          </Tooltip>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">The picture shows what it is; the game draws the character with its own font, so every player sees it. Very old versions may show a few as boxes.</p>
    </div>
  );
}

function ExamplesPanel({ canEdit, examples, onPick }: { canEdit: boolean; examples: MotdExample[]; onPick: (text: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">Pick one to replace the message with it, using your server's name. You can change everything afterwards.</p>
      <div role="group" aria-label="Examples" className="grid gap-2 sm:grid-cols-2">
        {examples.map((x) => (
          <button
            key={x.id}
            type="button"
            disabled={!canEdit}
            aria-label={`Use the example ${x.label}`}
            onClick={() => onPick(x.text)}
            className="space-y-1.5 rounded-md border border-border p-2 text-left outline-none transition-colors hover:border-foreground/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="block text-xs font-medium text-muted-foreground">{x.label}</span>
            <span className="block overflow-hidden rounded bg-console p-2">
              <MotdText raw={x.text} className="text-[12px]" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
