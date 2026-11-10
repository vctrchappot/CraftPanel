"use client";

import * as React from "react";
import { cn } from "./cn";

/** What marks the selected item inside a switch: Radix tabs (`data-state`) or our own buttons (`aria-pressed`, `aria-checked`, `aria-selected`). */
const ACTIVE = '[data-state="active"], [aria-pressed="true"], [aria-checked="true"], [aria-selected="true"]';

/**
 * The highlight of a switch that glides to the newly selected item instead of jumping.
 *
 * Render it as the first child of a `relative` container whose items mark the selected one via one of the
 * attributes in `ACTIVE`; it follows whatever carries the mark, so it also works for items it knows nothing about.
 * Everything that should look like a switch (segmented controls, tab lists) goes through this one component, so
 * the motion stays the same everywhere. The first placement and anyone who prefers reduced motion get no animation.
 */
export function SlidingIndicator({ className }: { className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;

    const place = () => {
      const active = host.querySelector<HTMLElement>(ACTIVE);
      el.style.opacity = active ? "" : "0";
      if (!active) return;
      el.style.width = `${active.offsetWidth}px`;
      el.style.height = `${active.offsetHeight}px`;
      el.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    };

    const resize = new ResizeObserver(() => place());
    const observe = () => {
      resize.disconnect();
      resize.observe(host);
      for (const child of host.children) resize.observe(child);
    };
    const mutations = new MutationObserver(() => {
      observe();
      place();
    });

    place();
    observe();
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "aria-pressed", "aria-checked", "aria-selected"] });
    // Switch the transition on only after the first placement, so a fresh switch starts in place instead of sliding in from the corner.
    const frame = requestAnimationFrame(() => (el.dataset.ready = ""));
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      delete el.dataset.ready;
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-0 top-0 rounded-md bg-muted data-[ready]:transition-[transform,width,height] data-[ready]:duration-200 data-[ready]:ease-out motion-reduce:transition-none!",
        className,
      )}
    />
  );
}

/** Classes every item of a switch needs: above the indicator, and the text colour follows the selection. */
export const switchItemClass = "relative z-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

/**
 * Pick one of a few options, shown side by side (time range, source, view). The selection slides between options.
 * For a choice that swaps a whole panel, use `Tabs`; for on/off, `Switch`.
 */
export function SegmentedControl<T extends string | number>({
  value,
  onValueChange,
  options,
  className,
  itemClassName,
  indicatorClassName,
  ...props
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  className?: string;
  itemClassName?: string;
  indicatorClassName?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "children"> &
  ({ "aria-label": string } | { "aria-labelledby": string })) {
  return (
    <div role="group" className={cn("relative inline-flex rounded-md border border-border bg-surface p-0.5", className)} {...props}>
      <SlidingIndicator className={indicatorClassName} />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          aria-pressed={value === o.value}
          onClick={() => onValueChange(o.value)}
          className={cn(
            switchItemClass,
            "whitespace-nowrap rounded px-3 py-1.5 text-xs aria-pressed:font-medium aria-pressed:text-foreground text-muted-foreground hover:text-foreground",
            itemClassName,
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
