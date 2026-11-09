import { snapshotState, restoreState, snapshotRuntime, restoreRuntime } from "./state-snapshot";

/** Stable installer-only protocol. This bundle must never import or start the application. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--protocol") {
    console.log("craftpanel-recovery-v1");
    return;
  }
  const [action, dataDir, snapshotDir] = args;
  const actions: Record<string, typeof snapshotState> = { snapshot: snapshotState, restore: restoreState, "snapshot-runtime": snapshotRuntime, "restore-runtime": restoreRuntime };
  if (args.length !== 3 || !Object.hasOwn(actions, action))
    throw new Error("Usage (CraftPanel must be stopped): node recovery.js <snapshot|restore|snapshot-runtime|restore-runtime> <data-dir> <snapshot-dir>");
  await actions[action](dataDir, snapshotDir);
}

main().catch((error) => {
  console.error(`CraftPanel database recovery failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
