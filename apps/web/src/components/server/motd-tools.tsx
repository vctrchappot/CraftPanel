"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { Button, SegmentedControl, cn } from "@craftpanel/ui";
import { MOTD_EFFECTS } from "@craftpanel/shared";

const gradientCss = (stops: readonly string[]) => `linear-gradient(90deg, ${stops.join(", ")})`;

/** Symbols the game's built-in font draws, grouped for the picker. */
export const MOTD_SYMBOLS: { id: string; label: string; symbols: string[] }[] = [
  { id: "shine", label: "Stars & hearts", symbols: [..."★☆✦✧✪✯❤♥♡❣✿❀❁☘☀☁☂❄⚡☽☾"] },
  { id: "marks", label: "Arrows & marks", symbols: [..."»«›‹➤➜➔→←↑↓⇒▶◀▲▼✔✘✖✚✜✱⚠"] },
  { id: "fun", label: "Game & fun", symbols: [..."⚔☠⚒⚓⚑⚙✂✎☢☣♠♣♦♪♫☎✉⌛☯☮"] },
  { id: "lines", label: "Shapes & lines", symbols: [..."■□●○◆◇▪▫◈◉▌█▓░━─═║╔╗╚╝⋆•‣※❖"] },
];

/** Colour effects over the selected text (or the whole message): ready-made gradients and a custom two-colour one. */
export function EffectTools({
  canEdit,
  smooth,
  onSmooth,
  hexServer,
  onPaint,
}: {
  canEdit: boolean;
  smooth: boolean;
  onSmooth: (smooth: boolean) => void;
  /** The server software shows smooth colours (Paper, Purpur); Vanilla, Fabric and NeoForge do not. */
  hexServer: boolean;
  onPaint: (stops: readonly string[]) => void;
}) {
  const [from, setFrom] = React.useState("#ff7a18");
  const [to, setTo] = React.useState("#8e2de2");
  const keepSelection = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <Sparkles className="size-3.5 text-muted-foreground" aria-hidden /> Colour effects
        </p>
        <SegmentedControl
          aria-label="Colour mode"
          value={smooth ? "smooth" : "classic"}
          onValueChange={(v) => onSmooth(v === "smooth")}
          options={[
            { value: "smooth", label: "Smooth colours" },
            { value: "classic", label: "16 classic colours" },
          ]}
        />
      </div>
      <div role="group" aria-label="Effects" className="flex flex-wrap gap-1.5">
        {MOTD_EFFECTS.map((e) => (
          <button
            key={e.id}
            type="button"
            disabled={!canEdit}
            title={`${e.name}: applies to the selection, or to the whole message`}
            onMouseDown={keepSelection}
            onClick={() => onPaint(e.stops)}
            className="group flex flex-col gap-1 rounded-md border border-border bg-background px-2.5 pb-1.5 pt-1 text-xs outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>{e.name}</span>
            <span aria-hidden className="h-1 w-full rounded-full" style={{ backgroundImage: gradientCss(e.stops) }} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Your own</span>
        <input type="color" aria-label="Gradient start colour" value={from} disabled={!canEdit} onChange={(e) => setFrom(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50" />
        <span aria-hidden className="h-1 w-10 rounded-full" style={{ backgroundImage: gradientCss([from, to]) }} />
        <input type="color" aria-label="Gradient end colour" value={to} disabled={!canEdit} onChange={(e) => setTo(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50" />
        <Button type="button" variant="secondary" size="sm" disabled={!canEdit} onMouseDown={keepSelection} onClick={() => onPaint([from, to])}>
          Apply gradient
        </Button>
      </div>
      <p className={cn("text-xs", smooth && !hexServer ? "text-warning" : "text-muted-foreground")}>
        {smooth
          ? hexServer
            ? "Smooth colours show in full on Paper and Purpur. Each coloured letter takes 14 characters."
            : "This server's software can't show smooth colours; players would see wrong ones. Use the 16 classic colours, or switch to Paper."
          : "Classic mode picks the nearest of the game's 16 colours for each letter, so it works on every server."}
      </p>
    </div>
  );
}

/** A small grid of symbols to put into the message at the cursor. */
export function SymbolPicker({ canEdit, onPick }: { canEdit: boolean; onPick: (symbol: string) => void }) {
  const [group, setGroup] = React.useState(MOTD_SYMBOLS[0].id);
  const current = MOTD_SYMBOLS.find((g) => g.id === group) ?? MOTD_SYMBOLS[0];
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium">Symbols</p>
        <SegmentedControl aria-label="Symbol group" value={group} onValueChange={setGroup} options={MOTD_SYMBOLS.map((g) => ({ value: g.id, label: g.label }))} />
      </div>
      <div role="group" aria-label={current.label} className="flex flex-wrap gap-1">
        {current.symbols.map((symbol) => (
          <button
            key={symbol}
            type="button"
            disabled={!canEdit}
            aria-label={`Insert ${symbol}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(symbol)}
            className="grid size-8 place-items-center rounded-md border border-border bg-background text-base outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {symbol}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">They come from the game's own font, so every player sees them. Very old versions may show a few as boxes.</p>
    </div>
  );
}
