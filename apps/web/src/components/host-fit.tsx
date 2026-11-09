"use client";

import { AlertTriangle, Gauge } from "lucide-react";
import { Button, Callout } from "@craftpanel/ui";
import type { FitLevel, HostFit } from "@craftpanel/shared";

const VARIANT: Record<FitLevel, "success" | "warning" | "danger"> = { good: "success", tight: "warning", poor: "danger" };

/**
 * One calm card that says whether the machine carries the planned server. Shown where memory and performance
 * are chosen; it only speaks up with hints when something is off. `onUse` offers the suggested memory.
 */
export function HostFitCard({ fit, memoryMb, onUse }: { fit: HostFit; memoryMb?: number; onUse?: (mb: number) => void }) {
  const differs = memoryMb !== undefined && Math.abs(memoryMb - fit.suggestedMemoryMb) >= 512;
  return (
    <Callout variant={VARIANT[fit.level]} icon={fit.level === "good" ? <Gauge /> : <AlertTriangle />} title={fit.headline}>
      <p>{fit.summary}</p>
      {fit.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
      {onUse && differs && (
        <div className="pt-1.5">
          <Button size="sm" variant="secondary" onClick={() => onUse(fit.suggestedMemoryMb)}>
            Use {(fit.suggestedMemoryMb / 1024).toFixed(fit.suggestedMemoryMb % 1024 === 0 ? 0 : 1)} GB
          </Button>
        </div>
      )}
    </Callout>
  );
}
