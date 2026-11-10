"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, ImagePlus, RotateCcw, Save, Trash2, Wand2 } from "lucide-react";
import { Button, Callout, ConfirmDialog, Field, Input, Panel, SegmentedControl, Section, Skeleton, Switch, Textarea, cn } from "@craftpanel/ui";
import { MOTD_EFFECTS, MOTD_MAX_LENGTH, MOTD_MAX_LINES, SOFTWARE_INFO, motdPlainOffset, motdProblem, motdRawIndex, paintMotd, restyleMotd, stripMotd, type MotdChange, type MotdFormatKey, type MotdRotation, type MotdRotationState, type ServerDetail } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { DEFAULT_CROP, ICON_PX, ICON_THEMES, clampPan, drawCrop, drawGenerated, initialsOf, pngBase64, type CropState, type Generated, type IconPattern } from "@/lib/icon-art";
import { formatNumber } from "@/lib/format";
import { StatusBadge } from "../status";
import { ServerIcon, iconUrl } from "../server-icon";
import { MotdText, ServerListEntry, useRotationIndex } from "./motd-preview";
import { ColourStyleBar, MotdTools } from "./motd-tools";
import { RotationSection } from "./rotation";

const DEFAULT_MOTD = "A Minecraft Server";

/** Everything about how a server presents itself: its icon, the message in the game's server list, and its description. */
export function AppearanceTab({ server: s }: { server: ServerDetail }) {
  const game = !SOFTWARE_INFO[s.software].proxy;
  const canEdit = useCan("server.configure");
  const props = useQuery({
    queryKey: ["properties", s.id],
    queryFn: () => api.get<{ values: Record<string, string> }>(`/api/servers/${s.id}/properties`),
    enabled: game,
  });
  const rotationQuery = useQuery({
    queryKey: ["motd-rotation", s.id],
    queryFn: () => api.get<MotdRotationState>(`/api/servers/${s.id}/motd-rotation`),
    enabled: game,
  });
  const [iconDraft, setIconDraft] = React.useState<string | null>(null);
  const [rotationDraft, setRotationDraft] = React.useState<MotdRotation | null>(null);
  const [motdDraft, setMotdDraft] = React.useState<string | null>(null);
  const [descDraft, setDescDraft] = React.useState<string | null>(null);
  const savedMotd = props.data?.values.motd ?? DEFAULT_MOTD;
  const motd = motdDraft ?? savedMotd;
  const description = descDraft ?? s.description;
  const savedRotation = rotationQuery.data;
  const rotation: MotdRotation | null = rotationDraft ?? savedRotation ?? null;
  const rotatingFrames = savedRotation?.supported && rotation ? rotation.frames : [];
  // While messages rotate, the preview plays them one after the other like the game's list does.
  const due = useRotationIndex(rotatingFrames.length, rotation?.interval ?? 5);
  const listed = rotatingFrames.length ? rotatingFrames[due] : motd;

  return (
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-10">
        <IconSection server={s} canEdit={canEdit} onDraft={setIconDraft} />
        {game &&
          (props.data ? (
            <MotdSection server={s} canEdit={canEdit} saved={savedMotd} value={motd} onChange={(v) => setMotdDraft(v === savedMotd ? null : v)} />
          ) : (
            <Skeleton className="h-64 rounded-lg" />
          ))}
        {game && savedRotation && rotation && (
          <RotationSection
            server={s}
            canEdit={canEdit}
            saved={savedRotation}
            value={rotation}
            editorText={motd}
            onChange={(next) => setRotationDraft(next.interval === savedRotation.interval && next.frames.length === savedRotation.frames.length && next.frames.every((f, i) => f === savedRotation.frames[i]) ? null : next)}
          />
        )}
        <DescriptionSection server={s} canEdit={canEdit} value={description} onChange={(v) => setDescDraft(v === s.description ? null : v)} />
      </div>
      <aside className="order-first min-w-0 space-y-6 xl:sticky xl:top-6 xl:order-none">
        <Section title="Preview" description="How this server looks, with your changes before they are saved.">
          <div className="space-y-5">
            {game && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">In Minecraft's server list</p>
                <ServerListEntry server={s} motd={listed} iconSrc={iconDraft ?? undefined} />
                {rotatingFrames.length > 0 && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Rotating: message {due + 1} of {rotatingFrames.length}, every {rotation?.interval} seconds
                  </p>
                )}
              </div>
            )}
            {!game && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">In Minecraft's server list</p>
                <ServerListEntry server={s} motd={null} iconSrc={iconDraft ?? undefined} />
                <p className="text-xs text-muted-foreground">A proxy takes its message of the day from velocity.toml (Files tab).</p>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">In this dashboard</p>
              <Panel className="flex items-start gap-3 p-4">
                <ServerIcon server={s} size={40} src={iconDraft ?? undefined} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="truncate font-medium">{s.name}</p>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className={cn("mt-0.5 line-clamp-3 whitespace-pre-line text-[13px]", description ? "text-muted-foreground" : "text-muted-foreground/70")}>{description || "No description"}</p>
                </div>
              </Panel>
            </div>
          </div>
        </Section>
      </aside>
    </div>
  );
}

// ---- icon --------------------------------------------------------------------------------------------------------

type IconMode = "upload" | "generate";
interface Loaded {
  source: CanvasImageSource;
  width: number;
  height: number;
}

async function loadImage(file: File): Promise<Loaded> {
  if (file.size > 16 * 1024 * 1024) throw new Error("This file is larger than 16 MB. Pick a smaller picture.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // An SVG without a size reports 0; give it a sharp working size.
    let width = img.naturalWidth || 512;
    let height = img.naturalHeight || 512;
    const cap = 1024;
    if (Math.max(width, height) <= cap && img.naturalWidth) return { source: img, width, height };
    const k = Math.min(1, cap / Math.max(width, height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(width * k));
    c.height = Math.max(1, Math.round(height * k));
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    width = c.width;
    height = c.height;
    return { source: c, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CHECKER = { backgroundImage: "repeating-conic-gradient(var(--color-border) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" } as const;
const BACKDROPS: { id: string; label: string; value: string | null }[] = [
  { id: "clear", label: "Transparent", value: null },
  { id: "dark", label: "Dark", value: "#1c1b18" },
  { id: "light", label: "Light", value: "#f4f1ea" },
  { id: "green", label: "Green", value: "#5bbf4a" },
];

function IconSection({ server: s, canEdit, onDraft }: { server: ServerDetail; canEdit: boolean; onDraft: (dataUrl: string | null) => void }) {
  const [mode, setMode] = React.useState<IconMode>("upload");
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [crop, setCrop] = React.useState<CropState>(DEFAULT_CROP);
  const [gen, setGen] = React.useState<Generated>({ text: initialsOf(s.name), theme: ICON_THEMES[0].id, pattern: "none", rounded: true });
  const [dragging, setDragging] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const picker = React.useRef<HTMLInputElement>(null);
  const drag = React.useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const hasIcon = s.iconVersion !== null;
  const hasDraft = mode === "generate" || loaded !== null;

  // Draw the draft into the 64×64 canvas and tell the preview about it.
  React.useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    if (mode === "generate") drawGenerated(ctx, { ...gen, fontFamily: getComputedStyle(document.body).fontFamily });
    else if (loaded) drawCrop(ctx, loaded.source, loaded.width, loaded.height, crop);
    else ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    onDraft(hasDraft ? el.toDataURL("image/png") : null);
  }, [mode, loaded, crop, gen, hasDraft, onDraft]);

  const done = () => {
    setLoaded(null);
    setCrop(DEFAULT_CROP);
    setMode("upload");
    onDraft(null);
  };
  const apply = useAction(() => api.put(`/api/servers/${s.id}/icon`, { png: pngBase64(canvas.current!) }), {
    success: () => (s.status === "running" ? "Icon saved. Restart the server to show it in the game." : "Icon saved. Players see it from the next start."),
    invalidate: [["server", s.id], ["servers"], ["overview", s.id]],
    onSuccess: done,
  });
  const remove = useAction(() => api.del(`/api/servers/${s.id}/icon`), {
    success: s.status === "running" ? "Icon removed. Restart the server to apply it." : "Icon removed.",
    invalidate: [["server", s.id], ["servers"], ["overview", s.id]],
  });

  const take = async (file: File | undefined) => {
    if (!file) return;
    try {
      setLoaded(await loadImage(file));
      setCrop(DEFAULT_CROP);
      setMode("upload");
    } catch (err) {
      toast.error(err instanceof DOMException || (err instanceof Error && !err.message.includes("16 MB")) ? "This file could not be read as a picture. Try a PNG, JPEG, WebP or GIF." : errorMessage(err));
    }
  };

  const adjust = (patch: Partial<CropState>) => {
    if (!loaded) return;
    setCrop((c) => {
      const next = { ...c, ...patch };
      return { ...next, ...clampPan(loaded.width, loaded.height, next) };
    });
  };
  const move = (dx: number, dy: number) => adjust({ panX: crop.panX + dx, panY: crop.panY + dy });

  const showStage = mode === "generate" || loaded !== null;
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canEdit) void take(e.dataTransfer.files[0]);
  };

  return (
    <Section title="Icon" description="The picture players see next to the server in Minecraft's multiplayer list. Minecraft needs a 64 × 64 PNG; CraftPanel crops and resizes any picture for you.">
      <div className="space-y-5">
        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="space-y-2">
            <div
              className={cn("relative size-48 shrink-0 overflow-hidden rounded-lg border bg-surface", dragging ? "border-foreground" : "border-border")}
              style={CHECKER}
              onDragOver={(e) => {
                e.preventDefault();
                if (canEdit) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <canvas
                ref={canvas}
                width={ICON_PX}
                height={ICON_PX}
                tabIndex={mode === "upload" && loaded ? 0 : -1}
                aria-label={mode === "upload" && loaded ? "Icon preview. Drag to move the picture; arrow keys move it, plus and minus zoom." : "Icon preview"}
                className={cn("size-full touch-none [image-rendering:pixelated] outline-none focus-visible:ring-2 focus-visible:ring-ring", showStage ? "block" : "hidden", mode === "upload" && loaded && "cursor-grab active:cursor-grabbing")}
                onPointerDown={(e) => {
                  if (mode !== "upload" || !loaded) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, panX: crop.panX, panY: crop.panY };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const k = ICON_PX / e.currentTarget.getBoundingClientRect().width;
                  adjust({ panX: d.panX + (e.clientX - d.x) * k, panY: d.panY + (e.clientY - d.y) * k });
                }}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onKeyDown={(e) => {
                  if (mode !== "upload" || !loaded) return;
                  const step = e.shiftKey ? 4 : 1;
                  const handled: Record<string, () => void> = {
                    ArrowLeft: () => move(-step, 0),
                    ArrowRight: () => move(step, 0),
                    ArrowUp: () => move(0, -step),
                    ArrowDown: () => move(0, step),
                    "+": () => adjust({ zoom: Math.min(4, crop.zoom + 0.1) }),
                    "=": () => adjust({ zoom: Math.min(4, crop.zoom + 0.1) }),
                    "-": () => adjust({ zoom: Math.max(1, crop.zoom - 0.1) }),
                  };
                  if (handled[e.key]) {
                    e.preventDefault();
                    handled[e.key]();
                  }
                }}
              />
              {!showStage &&
                (hasIcon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the server's own 64 px icon
                  <img src={iconUrl(s.id, s.iconVersion)!} alt="Current server icon" className="size-full [image-rendering:pixelated]" />
                ) : (
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => picker.current?.click()}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/80 p-4 text-center text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  >
                    <ImagePlus className="size-6" />
                    {canEdit ? "Drop a picture here or choose a file" : "No icon yet"}
                  </button>
                ))}
            </div>
            <p className="text-center text-xs text-muted-foreground">{showStage ? "New icon (64 × 64)" : hasIcon ? "Current icon" : "No icon"}</p>
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            {canEdit && (
              <SegmentedControl
                aria-label="Where the icon comes from"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "upload", label: "From a picture" },
                  { value: "generate", label: "Generate one" },
                ]}
              />
            )}
            <input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml" onChange={(e) => (void take(e.target.files?.[0]), (e.target.value = ""))} />
            {!canEdit ? (
              <p className="text-[13px] text-muted-foreground">You can see the icon but not change it.</p>
            ) : mode === "upload" ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
                    <ImagePlus /> {loaded ? "Choose another picture" : "Choose a picture"}
                  </Button>
                  {loaded && (
                    <Button variant="ghost" size="sm" onClick={() => setCrop(DEFAULT_CROP)}>
                      <RotateCcw /> Reset
                    </Button>
                  )}
                </div>
                {loaded ? (
                  <div className="space-y-4">
                    <Field label="Zoom" htmlFor="icon-zoom" aside={<span className="font-mono text-xs text-muted-foreground">{Math.round(crop.zoom * 100)}%</span>}>
                      <input id="icon-zoom" type="range" min={1} max={4} step={0.01} value={crop.zoom} onChange={(e) => adjust({ zoom: Number(e.target.value) })} className="w-full accent-[var(--foreground)]" />
                    </Field>
                    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                      <div className="space-y-1.5">
                        <p className="text-[13px] font-medium">Fit</p>
                        <SegmentedControl
                          aria-label="How the picture fits the icon"
                          value={crop.fit}
                          onValueChange={(fit) => adjust({ fit, panX: 0, panY: 0 })}
                          options={[
                            { value: "fill", label: "Fill the icon" },
                            { value: "whole", label: "Whole picture" },
                          ]}
                        />
                      </div>
                      {crop.fit === "whole" && (
                        <div className="space-y-1.5">
                          <p className="text-[13px] font-medium">Behind it</p>
                          <div role="group" aria-label="Background" className="flex gap-1.5">
                            {BACKDROPS.map((b) => (
                              <button
                                key={b.id}
                                type="button"
                                aria-pressed={crop.background === b.value}
                                aria-label={b.label}
                                title={b.label}
                                onClick={() => adjust({ background: b.value })}
                                className="size-7 rounded-md border border-border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-background"
                                style={b.value ? { background: b.value } : CHECKER}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-6">
                      <div className="space-y-0.5">
                        <label htmlFor="icon-smooth" className="text-[13px] font-medium">
                          Smooth scaling
                        </label>
                        <p className="text-xs text-muted-foreground">Turn off for pixel art, so the edges stay sharp.</p>
                      </div>
                      <Switch id="icon-smooth" checked={crop.smooth} onCheckedChange={(smooth) => adjust({ smooth })} />
                    </div>
                    <p className="text-xs text-muted-foreground">Drag the picture to move it, or focus it and use the arrow keys.</p>
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">PNG, JPEG, WebP, GIF or SVG. Anything larger than 64 × 64 is cropped to a square and scaled down in your browser; nothing is uploaded until you apply it.</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <Field label="Lettering" htmlFor="icon-text" help="One to three characters, an initial or an emoji.">
                  <Input id="icon-text" value={gen.text} maxLength={6} onChange={(e) => setGen({ ...gen, text: Array.from(e.target.value).slice(0, 3).join("") })} className="max-w-32 text-center text-base" />
                </Field>
                <div className="space-y-1.5">
                  <p className="text-[13px] font-medium">Colour</p>
                  <div role="group" aria-label="Colour" className="flex flex-wrap gap-2">
                    {ICON_THEMES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={gen.theme === t.id}
                        aria-label={t.name}
                        title={t.name}
                        onClick={() => setGen({ ...gen, theme: t.id })}
                        className="size-8 rounded-md outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-background"
                        style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})` }}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <div className="space-y-1.5">
                    <p className="text-[13px] font-medium">Pattern</p>
                    <SegmentedControl
                      aria-label="Pattern"
                      value={gen.pattern}
                      onValueChange={(pattern: IconPattern) => setGen({ ...gen, pattern })}
                      options={[
                        { value: "none", label: "None" },
                        { value: "stripes", label: "Stripes" },
                        { value: "dots", label: "Dots" },
                        { value: "blocks", label: "Blocks" },
                      ]}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[13px] font-medium">Corners</p>
                    <SegmentedControl
                      aria-label="Corners"
                      value={gen.rounded ? "rounded" : "square"}
                      onValueChange={(v) => setGen({ ...gen, rounded: v === "rounded" })}
                      options={[
                        { value: "rounded", label: "Rounded" },
                        { value: "square", label: "Square" },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!hasDraft}>
              <Save /> Use this icon
            </Button>
            {hasDraft && (
              <Button variant="ghost" onClick={done}>
                Discard
              </Button>
            )}
            {hasIcon && !hasDraft && (
              <>
                <Button variant="secondary" asChild>
                  <a href={iconUrl(s.id, s.iconVersion)!} download={`${s.name}-icon.png`}>
                    <Download /> Download
                  </a>
                </Button>
                <Button variant="destructive-ghost" onClick={() => setConfirmRemove(true)}>
                  <Trash2 /> Remove icon
                </Button>
              </>
            )}
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Wand2 className="size-3.5" aria-hidden /> Shown in the game after the next start
            </span>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the server icon?"
        description="Players see Minecraft's default picture instead, from the next start. The file server-icon.png is deleted from the server folder."
        confirmLabel="Remove icon"
        destructive
        onConfirm={() => remove.mutateAsync()}
      />
    </Section>
  );
}

// ---- message of the day ------------------------------------------------------------------------------------------

const effectStops = (id: string) => MOTD_EFFECTS.find((e) => e.id === id)!.stops;

/** A bold title between two symbols, painted with an effect, and a subtitle line under it. */
const banner = (name: string, effect: string, mark: string, subtitle: string, smooth: boolean) => {
  const title = `${mark} ${name} ${mark}`;
  return `${paintMotd(`§l${title}`, 0, title.length, effectStops(effect), { smooth })}\n${subtitle}`;
};

const EXAMPLES: { id: string; label: string; make: (name: string, smooth: boolean) => string }[] = [
  { id: "classic", label: "Classic", make: (n) => `§a§l${n}§r\n§7A friendly survival server` },
  { id: "gold", label: "Golden welcome", make: (n) => `§6§l${n} §8» §eJoin the adventure!\n§7Survival, events and a friendly community` },
  { id: "cool", label: "Cool and calm", make: (n) => `§b§l${n}\n§fPlay together, build together` },
  { id: "rainbow", label: "Rainbow banner", make: (n, smooth) => banner(n, "rainbow", "✦", "§7Come and play!", smooth) },
  { id: "sunset", label: "Sunset", make: (n, smooth) => banner(n, "sunset", "★", "§eSurvival, events and friends", smooth) },
  { id: "frost", label: "Frost", make: (n, smooth) => banner(n, "frost", "❄", "§bCool builds, warm community", smooth) },
  { id: "fire", label: "Fire", make: (n, smooth) => banner(n, "fire", "⚔", "§6PvP, raids and glory", smooth) },
  { id: "forest", label: "Forest", make: (n, smooth) => banner(n, "forest", "☘", "§aCosy survival in the woods", smooth) },
  { id: "plain", label: "Plain", make: (n) => n },
];

function MotdSection({ server: s, canEdit, saved, value, onChange }: { server: ServerDetail; canEdit: boolean; saved: string; value: string; onChange: (v: string) => void }) {
  const area = React.useRef<HTMLTextAreaElement>(null);
  const problem = motdProblem(value);
  const dirty = value !== saved;
  const save = useAction(() => api.put(`/api/servers/${s.id}/properties`, { values: { motd: value } }), {
    success: s.status === "running" ? "Saved. Restart the server to show the new message." : "Message saved.",
    invalidate: [["properties", s.id], ["server", s.id], ["servers"]],
  });
  const lines = value.split("\n").length;
  const hexServer = SOFTWARE_INFO[s.software].hexMotd;
  const [smooth, setSmooth] = React.useState(hexServer);

  // Put the cursor (or the selection) back after the buttons changed the text.
  const edit = (next: string, from: number, to: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(from, to);
    });
  };
  // With text selected the change applies to what it looks like, and the codes are rewritten in a tidy order; with only
  // a cursor, the code is inserted so the next thing typed carries it.
  const restyle = (change: MotdChange, codeAtCursor?: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    if (a === b) {
      if (change.clear) return edit(stripMotd(value), 0, 0);
      return codeAtCursor ? edit(value.slice(0, a) + `§${codeAtCursor}` + value.slice(b), a + 2, a + 2) : undefined;
    }
    const from = motdPlainOffset(value, a);
    const to = motdPlainOffset(value, b);
    const next = restyleMotd(value, from, to, change);
    edit(next, motdRawIndex(next, from), to > from ? motdRawIndex(next, to - 1) + 1 : motdRawIndex(next, to));
  };
  const insert = (code: string) => restyle({ color: code }, code);
  const toggle = (key: MotdFormatKey, code: string) => restyle({ toggle: key }, code);
  const clear = () => restyle({ clear: true });
  // An effect colours the selection, or the whole message when nothing is selected.
  const paint = (stops: readonly string[]) => {
    const el = area.current;
    const a = el?.selectionStart ?? 0;
    const b = el?.selectionEnd ?? 0;
    const ranged = a !== b;
    const from = ranged ? motdPlainOffset(value, a) : 0;
    const to = ranged ? motdPlainOffset(value, b) : motdPlainOffset(value, value.length);
    const next = paintMotd(value, from, to, stops, { smooth });
    edit(next, motdRawIndex(next, from), ranged && to > from ? motdRawIndex(next, to - 1) + 1 : motdRawIndex(next, from));
  };
  const insertSymbol = (symbol: string) => {
    const a = area.current?.selectionStart ?? value.length;
    const b = area.current?.selectionEnd ?? value.length;
    edit(value.slice(0, a) + symbol + value.slice(b), a + symbol.length, a + symbol.length);
  };

  const examples = EXAMPLES.map((x) => ({ id: x.id, label: x.label, text: x.make(s.name, smooth) }));

  return (
    <Section title="Message of the day" description="The two lines under the server name in Minecraft's server list. Select some text, then pick a colour, a style or an effect; the preview on the right shows the result.">
      <div className="space-y-4">
        <Field
          label="Message"
          htmlFor="motd"
          error={problem ?? undefined}
          aside={
            <span className={cn("font-mono text-xs tabular-nums", value.length > MOTD_MAX_LENGTH ? "text-destructive" : "text-muted-foreground")}>
              {formatNumber(value.length)}/{MOTD_MAX_LENGTH}
            </span>
          }
          help={`${lines} of ${MOTD_MAX_LINES} lines. A colour or style takes two characters (§ and a letter or digit), a smooth colour fourteen. Roughly 50 characters fit on a line.`}
        >
          {/* One editor: the toolbar on top, the text in the middle and the message as the game draws it underneath. */}
          <div className={cn("overflow-hidden rounded-lg border bg-surface focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25", problem ? "border-destructive" : "border-border")}>
            <ColourStyleBar canEdit={canEdit} onColor={insert} onToggle={toggle} onClear={clear} />
            <Textarea
              id="motd"
              ref={area}
              rows={4}
              value={value}
              disabled={!canEdit}
              spellCheck={false}
              aria-invalid={!!problem}
              onChange={(e) => (e.target.value.split("\n").length <= MOTD_MAX_LINES ? onChange(e.target.value) : undefined)}
              className="rounded-none border-0 bg-transparent font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0"
            />
            <div className="border-t border-border bg-console px-3 py-2.5" aria-label="The message as the game draws it">
              <MotdText raw={value} />
            </div>
          </div>
        </Field>
        <MotdTools canEdit={canEdit} smooth={smooth} onSmooth={setSmooth} hexServer={hexServer} onPaint={paint} onSymbol={insertSymbol} examples={examples} onExample={onChange} />
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !!problem}>
              <Save /> Save message
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => onChange(saved)}>
                Discard
              </Button>
            )}
          </div>
        )}
        {s.status === "running" && dirty === false && <Callout variant="info">Minecraft reads the message when it starts, so a saved change shows after a restart.</Callout>}
      </div>
    </Section>
  );
}

// ---- description -------------------------------------------------------------------------------------------------

const DESCRIPTION_MAX = 280;

function DescriptionSection({ server: s, canEdit, value, onChange }: { server: ServerDetail; canEdit: boolean; value: string; onChange: (v: string) => void }) {
  const dirty = value !== s.description;
  const save = useAction(() => api.patch(`/api/servers/${s.id}`, { description: value.trim() }), { success: "Description saved.", invalidate: [["server", s.id], ["servers"]] });
  return (
    <Section title="Description" description="A note for you and your team, shown on the server's card, in the lists and under its name. Players don't see it.">
      <div className="space-y-4">
        <Field
          label="Description"
          htmlFor="description"
          aside={
            <span className={cn("font-mono text-xs tabular-nums", value.length > DESCRIPTION_MAX ? "text-destructive" : "text-muted-foreground")}>
              {value.length}/{DESCRIPTION_MAX}
            </span>
          }
          help="For example what the server is for, who may join, or what to remember before changing it."
        >
          <Textarea id="description" rows={3} value={value} maxLength={DESCRIPTION_MAX} disabled={!canEdit} onChange={(e) => onChange(e.target.value)} placeholder="Survival world for the family, whitelisted" />
        </Field>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              <Save /> Save description
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => onChange(s.description)}>
                Discard
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

