// Bundles the API and all workspace packages into dist/index.js, and copies
// database migrations, bundled assets (the info plugin) and the exported web dashboard next to it.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

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
  // Smaller and faster to parse (matters on a Raspberry Pi); names are kept for readable stack traces.
  minify: true,
  keepNames: true,
  // Some dependencies use require(); give ESM output a working require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

fs.cpSync(path.resolve(here, "../../packages/database/drizzle"), path.join(dist, "drizzle"), { recursive: true });
fs.cpSync(path.join(here, "assets"), path.join(dist, "assets"), { recursive: true });
const web = path.resolve(here, "../web/out");
if (fs.existsSync(path.join(web, "index.html"))) {
  fs.cpSync(web, path.join(dist, "web"), { recursive: true });
  precompress(path.join(dist, "web"));
}
else console.warn("apps/web/out not found — build the web app first (pnpm build at the repo root does both).");
console.log("Built", dist);

/** Write .br and .gz next to text assets so the dashboard is served compressed without CPU work per request. */
function precompress(dir) {
  let before = 0;
  let after = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|css|html|json|svg|txt|map)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const data = fs.readFileSync(file);
    if (data.length < 1024) continue;
    const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    fs.writeFileSync(file + ".br", br);
    fs.writeFileSync(file + ".gz", zlib.gzipSync(data, { level: 9 }));
    before += data.length;
    after += br.length;
  }
  console.log(`Precompressed dashboard: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (brotli)`);
}
