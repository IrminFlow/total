import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const renderer = path.join(root, "out", "renderer");
const html = fs.readFileSync(path.join(renderer, "index.html"), "utf8");
const entry = html.match(/src=["'][^"']*assets\/([^"']+\.js)["']/)?.[1];
if (!entry) throw new Error("Could not resolve the renderer entry chunk");
const assets = path.join(renderer, "assets");
const chunks = fs
  .readdirSync(assets)
  .filter((file) => file.endsWith(".js"))
  .map((file) => ({ file, bytes: fs.statSync(path.join(assets, file)).size }));
const entryBytes =
  chunks.find((chunk) => chunk.file === entry)?.bytes ?? Infinity;
const largestAsync = Math.max(
  0,
  ...chunks.filter((chunk) => chunk.file !== entry).map((chunk) => chunk.bytes),
);
const budgets = {
  entryBytes: 1_150_000,
  largestAsyncBytes: 350_000,
  minimumChunks: 20,
};
const metrics = {
  entryBytes,
  largestAsyncBytes: largestAsync,
  chunks: chunks.length,
};
const failures = [
  ...(entryBytes > budgets.entryBytes
    ? [`entry ${entryBytes} > ${budgets.entryBytes}`]
    : []),
  ...(largestAsync > budgets.largestAsyncBytes
    ? [`largest async ${largestAsync} > ${budgets.largestAsyncBytes}`]
    : []),
  ...(chunks.length < budgets.minimumChunks
    ? [`only ${chunks.length} chunks; route splitting regressed`]
    : []),
];
if (failures.length)
  throw new Error(`Renderer performance budget failed: ${failures.join("; ")}`);
console.log(JSON.stringify({ ok: true, budgets, metrics }));
