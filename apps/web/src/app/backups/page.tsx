import { AppShell } from "@/components/shell";
import { BackupsView } from "@/components/backups-view";

export const metadata = { title: "Backups" };
export default function Page() {
  return (
    <AppShell>
      <BackupsView />
    </AppShell>
  );
}
