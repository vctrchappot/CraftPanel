import { snapshotState, restoreState } from "./state-snapshot";

/** Stable installer-only protocol. This bundle must never import or start the application. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--protocol") {
    console.log("craftpanel-recovery-v1");
    return;
  }
  const [action, dataDir, snapshotDir] = args;
  if (args.length !== 3 || !["snapshot", "restore"].includes(action))
    throw new Error("Usage (CraftPanel must be stopped): node recovery.js <snapshot|restore> <data-dir> <snapshot-dir>");
  await (action === "snapshot" ? snapshotState : restoreState)(dataDir, snapshotDir);
}

main().catch((error) => {
  console.error(`CraftPanel database recovery failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
