import path from "node:path";
import { RuntimeService, RUNTIME_PROTOCOL } from "@craftpanel/server-runtime";

if (process.argv.includes("--protocol")) {
  console.log(`craftpanel-runtime-v${RUNTIME_PROTOCOL}`);
} else {
  const root = path.resolve(process.env.CRAFTPANEL_DATA_DIR ?? ".data");
  const runtime = new RuntimeService(root);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Runtime shutdown: saving and stopping Minecraft servers…");
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  if (process.platform === "win32") process.on("SIGBREAK", () => void stop());
  runtime.listen().then(() => console.log(`CraftPanel runtime protocol ${RUNTIME_PROTOCOL} ready (${root})`)).catch((err) => {
    console.error("Runtime failed to start:", err);
    process.exit(1);
  });
}
