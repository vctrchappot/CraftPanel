import { AppShell } from "@/components/shell";
import { SettingsView } from "@/components/settings-view";

export const metadata = { title: "Settings" };
export default function Page() {
  return (
    <AppShell>
      <SettingsView />
    </AppShell>
  );
}
