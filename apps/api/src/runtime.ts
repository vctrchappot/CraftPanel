import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { RuntimeClient, RuntimeService, RUNTIME_PROTOCOL } from "@craftpanel/server-runtime";

if (process.argv.includes("--protocol")) {
  console.log(`craftpanel-runtime-v${RUNTIME_PROTOCOL}`);
} else if (process.argv.includes("--status") || process.argv.includes("--shutdown") || process.argv.includes("--stop-all")) {
  const client = new RuntimeClient(path.resolve(process.env.CRAFTPANEL_DATA_DIR ?? ".data"));
  try {
    await client.connect();
    if (process.argv.includes("--shutdown")) await client.requestServiceShutdown();
    else if (process.argv.includes("--stop-all")) console.log(JSON.stringify(await client.stopAll()));
    else console.log(JSON.stringify({ connected: client.connected, ...client.identity }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally { await client.disconnect(); }
} else {
  const root = path.resolve(process.env.CRAFTPANEL_DATA_DIR ?? ".data");
  const bundleHash = crypto.createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex");
  let build = bundleHash;
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL("./runtime-manifest.json", import.meta.url), "utf8"));
    if (manifest.bundleSha256 !== bundleHash) throw new Error("Runtime bundle checksum does not match its manifest");
    build = manifest.sha256;
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const runtime = new RuntimeService(root, build);
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
