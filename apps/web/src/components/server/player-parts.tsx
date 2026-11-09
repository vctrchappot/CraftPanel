"use client";

import * as React from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, Field, Input } from "@craftpanel/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";

/** Everything the player views can do to a player; one place so the list and the profile stay in step. */
export interface PlayerActionInput {
  action: string;
  name?: string;
  reason?: string;
  ip?: string;
  enabled?: boolean;
}

export function usePlayerActions(serverId: string) {
  return useAction((v: PlayerActionInput) => api.post(`/api/servers/${serverId}/players/${v.action}`, { name: v.name, reason: v.reason, ip: v.ip, enabled: v.enabled }), {
    success: "Done",
    invalidate: [["players", serverId], ["player", serverId]],
  });
}

export const playerHref = (serverId: string, name: string) => `/server/?id=${serverId}&tab=players&player=${encodeURIComponent(name)}`;

function hash(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // mulberry32: a few well-spread numbers from one seed
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKIN = ["#f1c9a5", "#e0ac69", "#d9a066", "#b87b4b", "#8d5524", "#ffdbac"];
const HAIR = ["#2b1d0e", "#5a3825", "#a0682e", "#d9b44a", "#1b1b1b", "#7a3b1f", "#b8b8b8", "#3a6b35", "#3b5bdb"];
const IRIS = ["#3a5a9b", "#2f6b4f", "#5b3a1e", "#1b1b1b", "#6b4aa0"];

/**
 * A pixel face drawn from the player's UUID (or name). Skins live on Mojang's servers and the dashboard makes no
 * third-party requests, so this is a stand-in that is stable per player, not their actual skin.
 */
export function PlayerAvatar({ name, uuid, size = 32, className }: { name: string; uuid?: string | null; size?: number; className?: string }) {
  const cells = React.useMemo(() => {
    const rnd = hash((uuid ?? name).toLowerCase());
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const skin = pick(SKIN);
    const hair = pick(HAIR);
    const iris = pick(IRIS);
    const out: { x: number; y: number; c: string; o?: number }[] = [];
    const px = (x: number, y: number, c: string, o?: number) => out.push({ x, y, c, o });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(x, y, skin);
    for (let x = 0; x < 8; x++) {
      px(x, 0, hair);
      px(x, 1, hair);
    }
    // Fringe and sideburns, mirrored.
    const fringe = Array.from({ length: 4 }, () => rnd() < 0.55);
    fringe.forEach((f, i) => {
      if (f) {
        px(i, 2, hair);
        px(7 - i, 2, hair);
      }
    });
    if (rnd() < 0.5) for (const y of [2, 3]) [0, 7].forEach((x) => px(x, y, hair));
    for (const x of [1, 6]) px(x, 3, "#ffffff");
    for (const x of [2, 5]) px(x, 3, iris);
    px(3, 4, "#000000", 0.12);
    px(4, 4, "#000000", 0.12);
    for (const x of [2, 3, 4, 5]) px(x, 6, "#000000", 0.28);
    if (rnd() < 0.3) for (const x of [1, 2, 3, 4, 5, 6]) px(x, 7, hair);
    return out;
  }, [name, uuid]);
  return (
    <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges" className={className} role="img" aria-label={`${name}'s avatar`}>
      {cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={c.c} fillOpacity={c.o} />
      ))}
    </svg>
  );
}

export function ReasonDialog({ state, onClose, onSubmit }: { state: { action: "kick" | "ban"; name: string } | null; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setReason(""), [state]);
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={state?.action === "ban" ? `Ban ${state.name}` : `Kick ${state?.name}`} description={state?.action === "ban" ? "The player is disconnected and cannot rejoin until unbanned." : "The player is disconnected but may rejoin."} />
        <Field label="Reason" htmlFor="reason" help="Optional. Shown to the player.">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={state?.action === "ban" ? "destructive" : "default"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(reason.trim());
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {state?.action === "ban" ? "Ban player" : "Kick player"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
