// Fails if the entry chunk's gzip size exceeds the budget. Unlike Vite's
// chunkSizeWarningLimit (a console warning only), this exits non-zero so CI can
// block regressions. Run after `vite build`: `pnpm --filter @platform/admin-ui size:check`.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const BUDGET_KB = Number(process.env.ENTRY_GZIP_BUDGET_KB ?? 230);
const distDir = new URL("../dist", import.meta.url).pathname;

const html = readFileSync(join(distDir, "index.html"), "utf8");
const match = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!match?.[1]) {
  console.error("size:check — could not find the entry script in dist/index.html");
  process.exit(2);
}

const entryPath = join(distDir, match[1].replace(/^\//, ""));
const gzipKb = gzipSync(readFileSync(entryPath)).length / 1024;
const chunks = readdirSync(join(distDir, "assets")).filter((f) =>
  f.endsWith(".js"),
).length;

console.log(
  `entry ${match[1]}: ${gzipKb.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB), ${chunks} js chunks`,
);
if (gzipKb > BUDGET_KB) {
  console.error(`size:check FAILED — entry exceeds ${BUDGET_KB} kB gzip`);
  process.exit(1);
}
