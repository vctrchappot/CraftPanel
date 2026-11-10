"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { Button, Callout, NativeSelect, Section, Textarea, cn } from "@craftpanel/ui";
import { MOTD_MAX_LINES, ROTATION_INTERVALS, ROTATION_MAX_FRAMES, motdProblem, rotationProblem, softwareLabel, stripMotd, type MotdRotation, type MotdRotationState, type ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { MotdText } from "./motd-preview";

/** Messages the server list shows in turn on Paper and Purpur; the CraftPanel plugin does the rotating. */
export function RotationSection({
  server: s,
  canEdit,
  saved,
  value,
  onChange,
  editorText,
}: {
  server: ServerDetail;
  canEdit: boolean;
  saved: MotdRotationState;
  value: MotdRotation;
  onChange: (next: MotdRotation) => void;
  /** What the message editor above holds, to copy into a rotating message. */
  editorText: string;
}) {
  const problem = rotationProblem(value);
  const dirty = value.interval !== saved.interval || value.frames.length !== saved.frames.length || value.frames.some((f, i) => f !== saved.frames[i]);
  const save = useAction(() => api.put(`/api/servers/${s.id}/motd-rotation`, { interval: value.interval, frames: value.frames }), {
    success: value.frames.length ? "Rotating messages saved." : "Rotating messages removed.",
    invalidate: [["motd-rotation", s.id], ["server", s.id], ["servers"]],
  });
  const setFrames = (frames: string[]) => onChange({ ...value, frames });
  const replace = (i: number, frame: string) => setFrames(value.frames.map((f, k) => (k === i ? frame : f)));
  const move = (i: number, by: -1 | 1) => {
    const frames = [...value.frames];
    [frames[i], frames[i + by]] = [frames[i + by], frames[i]];
    setFrames(frames);
  };
  const editorProblem = motdProblem(editorText);
  const canAdd = canEdit && value.frames.length < ROTATION_MAX_FRAMES && !editorProblem && !!stripMotd(editorText).trim();

  if (!saved.supported) {
    return (
      <Section title="Rotating messages" description="Show several messages in turn in the server list.">
        <p className="text-[13px] text-muted-foreground">
          {softwareLabel(s.software)} can only show the one message above. Rotating messages need Paper or Purpur, which can run the small CraftPanel plugin that swaps the message.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Rotating messages" description="Show several messages in turn in the server list, so it changes every few seconds. Design a message in the editor above, then add it here.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={!canAdd} onClick={() => setFrames([...value.frames, editorText])} title={editorProblem ?? "Add a copy of the message in the editor above"}>
            <Plus /> Add the message above
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {value.frames.length} of {ROTATION_MAX_FRAMES}
          </span>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
            Change every
            <NativeSelect aria-label="How long each message stays" value={String(value.interval)} disabled={!canEdit} onChange={(e) => onChange({ ...value, interval: Number(e.target.value) })} className="h-8 w-auto text-[13px]">
              {[...new Set<number>([...ROTATION_INTERVALS, value.interval])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n} seconds
                  </option>
                ))}
            </NativeSelect>
          </label>
        </div>

        {value.frames.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">No rotating messages. The server list shows the single message above.</p>
        ) : (
          <ol className="space-y-3">
            {value.frames.map((frame, i) => {
              const frameProblem = stripMotd(frame).trim() ? motdProblem(frame) : "This message is empty.";
              return (
                <li key={i} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 place-items-center rounded-md bg-surface font-mono text-xs tabular-nums">{i + 1}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button type="button" variant="ghost" size="sm" disabled={!canEdit || !!editorProblem || !stripMotd(editorText).trim()} onClick={() => replace(i, editorText)} title="Replace this message with the one in the editor above">
                        Use editor text
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move message ${i + 1} up`} disabled={!canEdit || i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move message ${i + 1} down`} disabled={!canEdit || i === value.frames.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove message ${i + 1}`} disabled={!canEdit} onClick={() => setFrames(value.frames.filter((_, k) => k !== i))}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  <div className="rounded-md bg-console p-2.5">
                    <MotdText raw={frame} />
                  </div>
                  <Textarea
                    aria-label={`Message ${i + 1}`}
                    aria-invalid={!!frameProblem}
                    rows={2}
                    value={frame}
                    disabled={!canEdit}
                    spellCheck={false}
                    onChange={(e) => (e.target.value.split("\n").length <= MOTD_MAX_LINES ? replace(i, e.target.value) : undefined)}
                    className={cn("font-mono text-xs leading-relaxed", frameProblem && "border-destructive")}
                  />
                  {frameProblem && <p className="text-xs text-destructive">{frameProblem}</p>}
                </li>
              );
            })}
          </ol>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !!problem}>
              <Save /> Save rotation
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => onChange({ interval: saved.interval, frames: saved.frames })}>
                Discard
              </Button>
            )}
          </div>
        )}
        <Callout variant="info">
          The game asks the server for its message each time the list opens or refreshes, and the plugin answers with the message that is due. Changes apply within seconds. The first time, restart the server so the plugin loads; while rotating messages are set, they replace the single message above.
        </Callout>
      </div>
    </Section>
  );
}
