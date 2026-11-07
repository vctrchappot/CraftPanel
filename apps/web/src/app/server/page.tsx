import { AppShell } from "@/components/shell";
import { ServerWorkspace } from "@/components/server/workspace";

export const metadata = { title: "Server" };
export default function Page() {
  return (
    <AppShell>
      <ServerWorkspace />
    </AppShell>
  );
}
