// Bundles the API and all workspace packages into dist/index.js, and copies
// database migrations and the exported web dashboard next to it.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
fs.rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Some dependencies use require(); give ESM output a working require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

fs.cpSync(path.resolve(here, "../../packages/database/drizzle"), path.join(dist, "drizzle"), { recursive: true });
const web = path.resolve(here, "../web/out");
if (fs.existsSync(path.join(web, "index.html"))) fs.cpSync(web, path.join(dist, "web"), { recursive: true });
else console.warn("apps/web/out not found — build the web app first (pnpm build at the repo root does both).");
console.log("Built", dist);
