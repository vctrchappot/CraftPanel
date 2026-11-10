"use client";

import * as React from "react";
import { Panel, cn } from "@craftpanel/ui";
import { formatClock } from "@/lib/format";

export interface Point {
  ts: number;
  v: number | null;
}

/** Sampling pauses when nobody has the dashboard open; a hole this long breaks the line instead of bridging it. */
const GAP_MS = 45_000;

interface Reference {
  value: number;
  label: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A small line chart for one metric over a time window: a zero baseline, three hairlines, an optional dashed
 * reference (tick budget, heap size), and a crosshair readout on hover or touch. Drawn as one stretched SVG with
 * non-scaling strokes, so it needs no measuring and no charting library.
 */
export function MetricChart({
  title,
  points,
  from,
  to,
  max,
  reference,
  format,
  empty,
  className,
  stat,
}: {
  title: string;
  points: Point[];
  from: number;
  to: number;
  max: number;
  reference?: Reference;
  format: (v: number) => string;
  empty: string;
  className?: string;
  stat?: { value: React.ReactNode; detail: string; hint: string; icon: React.ReactNode };
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<Point | null>(null);
  React.useEffect(() => setHover(null), [from, to]);
  const visible = React.useMemo(() => points.filter((p) => p.ts >= from && p.ts <= to), [points, from, to]);
  const known = visible.filter((p): p is Point & { v: number } => p.v !== null);
  const span = Math.max(1, to - from);
  const x = (ts: number) => ((ts - from) / span) * 100;
  const y = (v: number) => 100 - (clamp(v, 0, max) / max) * 100;

  const { line, area } = React.useMemo(() => {
    const lines: string[] = [];
    const areas: string[] = [];
    let run: (Point & { v: number })[] = [];
    const flush = () => {
      if (run.length) {
        const pts = run.map((p) => `${x(p.ts).toFixed(2)} ${y(p.v).toFixed(2)}`);
        lines.push(`M${pts.join(" L")}`);
        areas.push(`M${x(run[0].ts).toFixed(2)} 100 L${pts.join(" L")} L${x(run[run.length - 1].ts).toFixed(2)} 100 Z`);
      }
      run = [];
    };
    for (const p of visible) {
      if (p.v === null || (run.length && p.ts - run[run.length - 1].ts > GAP_MS)) flush();
      if (p.v !== null) run.push(p as Point & { v: number });
    }
    flush();
    return { line: lines.join(" "), area: areas.join(" ") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, from, to, max]);

  const latest = known[known.length - 1];
  const shown = hover ?? latest ?? null;
  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !known.length) return;
    const ts = from + clamp((e.clientX - r.left) / r.width, 0, 1) * span;
    let best = known[0];
    for (const p of known) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    setHover(best);
  };
  const summary = known.length ? `${title}: latest ${format(latest.v)}, range ${format(Math.min(...known.map((p) => p.v)))} to ${format(Math.max(...known.map((p) => p.v)))}` : `${title}: no data`;

  return (
    <Panel className={cn("min-w-0 p-4", stat && "p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        {stat && <span className="text-muted-foreground [&_svg]:size-4" aria-hidden>{stat.icon}</span>}
        {!stat && (
          <p className="truncate text-xs tabular-nums text-muted-foreground" aria-live="off">
            {shown && shown.v !== null ? (
              <>
                <span className="font-medium text-foreground">{format(shown.v)}</span>
                {hover && <> · {formatClock(hover.ts, true)}</>}
              </>
            ) : (
              "—"
            )}
          </p>
        )}
      </div>
      {stat && (
        <div className="mb-5 mt-2 space-y-1">
          <div className="text-3xl font-medium tracking-tight tabular-nums">{stat.value}</div>
          <p className="min-h-8 text-xs text-muted-foreground">{stat.hint}</p>
        </div>
      )}
      <div
        ref={box}
        role="img"
        aria-label={summary}
        className="relative mt-3 h-28 touch-pan-y select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          {[0, 50, 100].map((g) => (
            <line key={g} x1="0" x2="100" y1={g} y2={g} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {reference && reference.value <= max && (
            <line x1="0" x2="100" y1={y(reference.value)} y2={y(reference.value)} className="stroke-warning" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          )}
          {area && <path d={area} className="fill-foreground/[0.06]" />}
          {line && <path d={line} fill="none" className="stroke-foreground" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 -translate-y-1/2 bg-surface pr-1 font-mono text-[10px] leading-none text-muted-foreground">{format(max)}</span>
        {reference && reference.value <= max && (
          <span className="pointer-events-none absolute right-0 -translate-y-full pb-0.5 font-mono text-[10px] leading-none text-warning" style={{ top: `${y(reference.value)}%` }}>
            {reference.label}
          </span>
        )}
        {!known.length && <p className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground">{empty}</p>}
        {hover && hover.v !== null && (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30" style={{ left: `${x(hover.ts)}%` }} />
            <span className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-surface" style={{ left: `${x(hover.ts)}%`, top: `${y(hover.v)}%` }} />
          </>
        )}
      </div>
      {stat && (
        <>
          <div className="mt-2 flex justify-between gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{formatClock(from)}</span>
            <span>{formatClock(to)}</span>
          </div>
          <p className="mt-4 border-t border-border pt-3 text-xs tabular-nums text-muted-foreground" aria-live="off">
            {hover?.v != null ? `${format(hover.v)} at ${formatClock(hover.ts, true)}` : stat.detail}
          </p>
        </>
      )}
    </Panel>
  );
}
