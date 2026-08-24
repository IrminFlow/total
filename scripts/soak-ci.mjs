// Repeated production-shaped IPC exercise for company switching, reviewed imports, backups,
// restores and report generation. Runs against a built Electron app in an isolated data tree.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSoakIterations } from "./lib/soak.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...desktopEnv } = process.env;
const iterations = parseSoakIterations(process.env.TOTAL_SOAK_ITERATIONS);
const dataDir = process.env.TOTAL_DATA_DIR || mkdtempSync(join(tmpdir(), "total-soak-data-"));
const profileDir = join(dataDir, ".electron-profile");
const outDir = process.env.SMOKE_OUT || mkdtempSync(join(tmpdir(), "total-soak-evidence-"));
mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const startedAt = Date.now();
let app;
let page;
let exitCode = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

try {
  app = await electron.launch({
    executablePath: electronPath,
    // Keep Chromium state and requestSingleInstanceLock isolated from a developer's
    // live Total window and from concurrent release jobs. TOTAL_DATA_DIR isolates
    // company books, but Electron's application profile is a separate boundary.
    args: [`--user-data-dir=${profileDir}`, process.cwd()],
    timeout: 60_000,
    env: { ...desktopEnv, TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: "1" },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30_000 });
  const invoke = async (channel, payload) => {
    const response = await page.evaluate(([name, value]) => window.total.invoke(name, value), [channel, payload]);
    if (!response.ok) throw new Error(`${channel} failed: ${response.error}`);
    return response.data;
  };

  const now = new Date();
  const booksFrom = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyFrom = `${booksFrom}-04-01`;
  const today = now.toISOString().slice(0, 10);
  const companies = [];
  for (const suffix of ["North", "South"]) {
    const created = await invoke("company:create", {
      name: `Soak ${suffix}`,
      stateCode: "27",
      gstRegistrationType: "unregistered",
      gstin: null,
      address: "",
      booksFrom,
      email: null,
      phone: null,
    });
    await invoke("company:open", { slug: created.slug });
    const groups = await invoke("master:groups:list");
    const incomeGroup = groups.find((row) => row.name === "Indirect Incomes");
    assert(incomeGroup, "Indirect Incomes group exists");
    await invoke("master:ledgers:create", {
      name: "Soak Income",
      groupId: incomeGroup.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
    });
    companies.push({ slug: created.slug, imported: 0, amount: 0 });
  }

  for (let index = 0; index < iterations; index++) {
    const company = companies[index % companies.length];
    const opened = await invoke("company:open", { slug: company.slug });
    assert(opened.integrity.ok === true, `integrity is healthy when opening ${company.slug}`);
    const rupees = 100 + index;
    const amount = rupees * 100;
    const group = `SOAK-${String(index + 1).padStart(4, "0")}`;
    const csvText = [
      "Source ID,Voucher Group,Date,Voucher Type,Number,Ledger,Debit,Credit,Narration,Reference",
      `${group}-DR,${group},${today},Journal,,Cash,${rupees}.00,,Soak cycle ${index + 1},${group}`,
      `${group}-CR,${group},${today},Journal,,Soak Income,,${rupees}.00,Soak cycle ${index + 1},${group}`,
    ].join("\n");
    const preview = await invoke("import:preview", { kind: "generic_journal", csvText });
    assert(preview.willCreate === 1 && preview.errors.length === 0, `cycle ${index + 1} import previews cleanly`);
    const imported = await invoke("import:apply", { kind: "generic_journal", csvText });
    assert(imported.created === 1 && imported.errors.length === 0, `cycle ${index + 1} import applies once`);
    company.imported += 1;
    company.amount += amount;

    const trial = await invoke("report:trialBalance", { asOn: today });
    assert(trial.totalDebit === company.amount && trial.totalCredit === company.amount, `cycle ${index + 1} trial balance reconciles`);
    const dayBook = await invoke("report:dayBook", { from: fyFrom, to: today, includeOutOfBooks: false });
    assert(dayBook.length === company.imported, `cycle ${index + 1} day book retains all imports`);
    await invoke("report:profitLoss", { from: fyFrom, to: today, comparePrior: true });
    await invoke("report:balanceSheet", { asOn: today, comparePrior: true });
    await invoke("report:dashboard", { today, fyFrom });

    const backup = await invoke("backup:run");
    assert(typeof backup.path === "string" && backup.path.length > 0, `cycle ${index + 1} backup is written`);
    const backups = await invoke("backup:list");
    assert(backups.length > 0, `cycle ${index + 1} backup is listed`);
    const previewBackup = await invoke("backup:preview", { file: backups[0].file });
    assert(previewBackup.valid === true && previewBackup.integrity === "ok", `cycle ${index + 1} backup validates`);
    if ((index + 1) % 5 === 0) {
      const restored = await invoke("backup:restore", { file: backups[0].file });
      assert(restored.integrity.ok === true, `cycle ${index + 1} restored backup reopens cleanly`);
      const afterRestore = await invoke("report:trialBalance", { asOn: today });
      assert(afterRestore.totalDebit === company.amount && afterRestore.totalCredit === company.amount, `cycle ${index + 1} restore preserves balances`);
    }
  }

  for (const company of companies) {
    await invoke("company:open", { slug: company.slug });
    const finalTrial = await invoke("report:trialBalance", { asOn: today });
    assert(finalTrial.totalDebit === company.amount && finalTrial.totalCredit === company.amount, `${company.slug} final totals reconcile`);
  }
  const registry = await invoke("company:list");
  assert(registry.companies.length === 2, "both soak companies remain registered");
  const evidence = {
    schema: 1,
    ok: true,
    iterations,
    companySwitches: iterations + companies.length,
    imports: iterations,
    reports: iterations * 4 + companies.length,
    manualBackups: iterations,
    restores: Math.floor(iterations / 5),
    durationMs: Date.now() - startedAt,
    companies: companies.map(({ slug, imported, amount }) => ({ slug, vouchers: imported, totalDebit: amount, totalCredit: amount })),
  };
  writeFileSync(join(outDir, "soak-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await page.screenshot({ path: join(outDir, "success.png") });
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error("SOAK FAILED:", error instanceof Error ? error.stack || error.message : String(error));
  try { if (page) await page.screenshot({ path: join(outDir, "failure.png") }); } catch {}
  exitCode = 1;
} finally {
  try { await app?.close(); } catch {}
}
process.exit(exitCode);
