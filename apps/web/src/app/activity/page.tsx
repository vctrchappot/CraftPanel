import { AppShell } from "@/components/shell";
import { ActivityView } from "@/components/activity";

export const metadata = { title: "Activity" };
export default function Page() {
  return (
    <AppShell>
      <ActivityView />
    </AppShell>
  );
}
