import { AppShell } from "@/components/shell";
import { ServersView } from "@/components/servers-list";

export const metadata = { title: "Servers" };
export default function Page() {
  return (
    <AppShell>
      <ServersView />
    </AppShell>
  );
}
