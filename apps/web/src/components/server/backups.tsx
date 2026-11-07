"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { Button, Section } from "@craftpanel/ui";
import type { BackupInfo, ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { BackupTable } from "../backups-view";

export function ServerBackupsTab({ server: s }: { server: ServerDetail }) {
  const q = useQuery({ queryKey: ["backups", s.id], queryFn: () => api.get<BackupInfo[]>(`/api/backups?serverId=${s.id}`) });
  const canCreate = useCan("backup.create");
  const create = useAction(() => api.post(`/api/servers/${s.id}/backups`, {}), { success: "Backup started", invalidate: [["backups"]] });
  return (
    <Section
      title="Backups"
      description={
        s.status === "running"
          ? "While running, autosave is paused and the world is flushed to disk before archiving, then autosave resumes."
          : "Backups include worlds, configuration and plugins. Server jars and logs are excluded (they are re-downloadable)."
      }
      actions={
        canCreate && (
          <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
            <Archive /> Back up now
          </Button>
        )
      }
    >
      <BackupTable backups={q.data} loading={q.isLoading} serverStatus={{ [s.id]: s.status }} />
    </Section>
  );
}
