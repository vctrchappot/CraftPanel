import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * An update that changes the runtime bundle (its hash is the "runtime fingerprint") stops every Minecraft server.
 * So the runtime must contain only the code it needs: dashboard-only changes in `@craftpanel/shared` (schemas,
 * permissions, performance advice, the map, …) must not reach it. This relies on `"sideEffects": false` in
 * packages/shared/package.json; if this test fails, a dashboard-only change would force a game restart on every update.
 */
it("keeps dashboard-only code out of the runtime bundle", async () => {
  const result = await build({
    entryPoints: [path.join(root, "apps/api/src/runtime.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(Object.values(result.metafile.outputs)[0]!.inputs).map((f) => f.replaceAll("\\", "/"));
  const shared = inputs.filter((f) => f.includes("packages/shared/src/")).map((f) => path.posix.basename(f));
  // What the runtime really uses from shared: the software catalogue and the error type.
  expect(shared.sort()).toEqual(["errors.ts", "software.ts"]);
});
