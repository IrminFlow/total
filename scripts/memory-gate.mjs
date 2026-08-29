import { Harness, assert } from "./lib/harness.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const outDir =
  process.env.SMOKE_OUT ?? path.join(os.tmpdir(), "total-performance");
const h = new Harness({ outDir });
const budgets = {
  rendererHeapBytes: 350 * 1024 * 1024,
  mainRssBytes: 750 * 1024 * 1024,
  rendererGrowthBytes: 250 * 1024 * 1024,
};
const samples = [];
let cdp;

async function sample(label) {
  const metrics = await cdp.send("Performance.getMetrics");
  const rendererHeapBytes =
    metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
  const main = await h.app.evaluate(() => process.memoryUsage());
  samples.push({ label, rendererHeapBytes, mainRssBytes: main.rss });
}

try {
  await h.launch();
  cdp = await h.page.context().newCDPSession(h.page);
  await cdp.send("Performance.enable");
  await h.createDemoCompany();
  await sample("gateway");
  for (const screen of ["daybook", "banking", "payroll", "settings"]) {
    await h.goto(screen);
    if (screen === "settings") {
      await h.page
        .getByRole("button", { name: "Data health", exact: true })
        .click();
      await h.page.locator('[data-testid="data-health-settings"]').waitFor();
    }
    await sample(screen);
  }
  const peakRenderer = Math.max(
    ...samples.map((sample) => sample.rendererHeapBytes),
  );
  const peakMain = Math.max(...samples.map((sample) => sample.mainRssBytes));
  const rendererGrowth = peakRenderer - samples[0].rendererHeapBytes;
  assert(
    peakRenderer <= budgets.rendererHeapBytes,
    `renderer heap ${peakRenderer} exceeds budget`,
  );
  assert(
    peakMain <= budgets.mainRssBytes,
    `main RSS ${peakMain} exceeds budget`,
  );
  assert(
    rendererGrowth <= budgets.rendererGrowthBytes,
    `renderer growth ${rendererGrowth} exceeds budget`,
  );
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "memory-performance.json"),
    JSON.stringify(
      { measuredAt: new Date().toISOString(), budgets, samples },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      budgets,
      peakRenderer,
      peakMain,
      rendererGrowth,
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
} finally {
  await h.close();
}
