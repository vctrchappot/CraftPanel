import { AppShell } from "@/components/shell";
import { CreateServerWizard } from "@/components/wizard";

export const metadata = { title: "New server" };
export default function Page() {
  return (
    <AppShell>
      <CreateServerWizard />
    </AppShell>
  );
}
