import { build } from "esbuild";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

await build({
  entryPoints: ["scripts/total-mcp.mjs"],
  outfile: "out/mcp/total-mcp.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  minify: false,
  define: { __TOTAL_APP_VERSION__: JSON.stringify(version) },
});
