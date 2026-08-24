// Release-only acceptance against two packaged executables. The real public v0.4
// application creates representative books in a disposable data root. The signed
// candidate migrates those same files and verifies them twice. Evidence is bound to
// the source revision, the downloaded v0.4 package and the candidate installers.
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright-core";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const oldExecutable = resolveRequired("OLD_TOTAL_EXECUTABLE");
const candidateExecutable = resolveRequired("CURRENT_TOTAL_EXECUTABLE");
const publicArtifactPath = resolveRequired("PUBLIC_TOTAL_ARTIFACT");
const candidateArtifactDir = resolveRequired("CURRENT_TOTAL_ARTIFACT_DIR");
const platform = requiredValue("UPGRADE_PLATFORM");
const sourceRevision = requiredValue("GITHUB_SHA");
const expectedOldVersion = process.env.OLD_TOTAL_VERSION ?? "0.4.0";
const expectedCandidateVersion = process.env.CURRENT_TOTAL_VERSION ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const evidencePath = resolve(process.env.UPGRADE_EVIDENCE ?? "dist/upgrade-evidence.json");
const scratch = mkdtempSync(join(tmpdir(), "total-upgrade-smoke-"));
const dataDir = join(scratch, "data");
const profileDir = join(scratch, "profile");

assert(platform === "mac" || platform === "win", "UPGRADE_PLATFORM must be mac or win");
assert(/^[0-9a-f]{40}$/i.test(sourceRevision), "GITHUB_SHA must be a full release commit SHA");

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveRequired(name) {
  const path = resolve(requiredValue(name));
  if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`);
  return path;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifact(path) {
  return { name: basename(path), bytes: statSync(path).size, sha256: sha256File(path) };
}

function candidateArtifacts() {
  const extensions = platform === "mac" ? [".dmg", ".zip"] : [".exe"];
  const paths = readdirSync(candidateArtifactDir)
    .map((name) => join(candidateArtifactDir, name))
    .filter((path) => statSync(path).isFile() && extensions.some((extension) => path.endsWith(extension)));
  for (const extension of extensions)
    assert(paths.some((path) => path.endsWith(extension)), `Candidate artifact directory has no ${extension} file`);
  return paths.map(artifact).sort((a, b) => a.name.localeCompare(b.name));
}

function digestFixture(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function withApp(executablePath, work) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profileDir}`], timeout: 90_000, env: { ...env, TOTAL_DATA_DIR: dataDir, TOTAL_SUPPRESS_SYNC_WARNING: "1" } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.total), null, { timeout: 45_000 });
    const invoke = async (channel, payload) => {
      const result = await page.evaluate(([name, body]) => window.total.invoke(name, body), [channel, payload]);
      if (!result.ok) throw new Error(`${channel}: ${result.error}`);
      return result.data;
    };
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), arch: process.arch }));
    assert(identity.packaged, `Upgrade executable is not packaged: ${executablePath}`);
    return await work({ invoke, identity });
  } finally {
    await app.close();
  }
}

const ledgerDefaults = { openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: "eligible", priceLevelId: null, creditLimit: null };

async function snapshot(invoke, fixture) {
  const vouchers = await invoke("voucher:list", { from: "2026-08-01", to: "2026-08-31" });
  const fixtureVouchers = await Promise.all(fixture.voucherIds.map((id) => invoke("voucher:get", { id })));
  const trial = await invoke("report:trialBalance", { asOn: "2026-08-31" });
  const stock = (await invoke("stock:summary", { asOn: "2026-08-31" })).find((row) => row.stockItemId === fixture.stockItemId);
  const batch = (await invoke("stock:batches", { asOn: "2026-08-31", stockItemId: fixture.stockItemId })).find((row) => row.batchId === fixture.batchId);
  const bank = await invoke("bank:recon", { ledgerId: fixture.bankLedgerId, from: "2026-08-01", to: "2026-08-31" });
  const payroll = (await invoke("payroll:runs")).find((row) => row.id === fixture.payrollRunId);
  const gstr1 = await invoke("gst:gstr1", { from: "2026-08-01", to: "2026-08-31", period: "082026" });
  const tds = (await invoke("tds:summary", { fyStartYear: 2026 })).find((row) => row.sectionCode === "194C");
  const users = await invoke("users:list");
  assert(stock && batch && payroll && tds, "One or more representative v0.4 fixture domains are missing");
  return {
    vouchers: { count: vouchers.length, references: fixtureVouchers.map((row) => row.reference).filter(Boolean).sort() },
    trial: { totalDebit: trial.totalDebit, totalCredit: trial.totalCredit },
    inventory: { name: stock.name, openingQtyMilli: stock.openingQtyMilli, inwardQtyMilli: stock.inwardQtyMilli, outwardQtyMilli: stock.outwardQtyMilli, closingQtyMilli: stock.closingQtyMilli, closingValue: stock.closingValue },
    batch: { name: batch.batchName, mfgDate: batch.mfgDate, expiryDate: batch.expiryDate, closingQtyMilli: batch.closingQtyMilli },
    banking: { rows: bank.rows.length, clearedRows: bank.rows.filter((row) => row.bankDate).length, bookBalance: bank.bookBalance, bankBalance: bank.bankBalance },
    payroll: { month: payroll.month, voucherId: payroll.voucherId, lines: payroll.lines.map((line) => ({ employeeName: line.employeeName, gross: line.gross, net: line.net })) },
    gst: gstr1.summary.map((row) => ({ section: row.section, docs: row.docs, taxable: row.taxable, cgst: row.cgst, sgst: row.sgst, igst: row.igst })).filter((row) => row.docs || row.taxable || row.cgst || row.sgst || row.igst),
    tds: { sectionCode: tds.sectionCode, quarter: tds.quarter, deductees: tds.deductees, base: tds.base, tds: tds.tds },
    users: users.map((row) => ({ name: row.name, role: row.role, active: row.active })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function seedWithPublicRelease() {
  return withApp(oldExecutable, async ({ invoke, identity }) => {
    assert(identity.version === expectedOldVersion, `Expected public ${expectedOldVersion}, got ${identity.version}`);
    const created = await invoke("company:create", { name: "Public v0.4 Upgrade Books", stateCode: "27", gstin: "27AAPFU0939F1ZV", gstRegistrationType: "regular", address: "Migration evidence", booksFrom: 2026, email: null, phone: null, pan: "AAPFU0939F", tan: null });
    await invoke("company:open", { slug: created.slug });
    const types = await invoke("master:voucherTypes:list");
    const ledgers = await invoke("master:ledgers:list");
    const groups = await invoke("master:groups:list");
    const units = await invoke("master:units:list");
    const type = (kind) => types.find((row) => row.kind === kind);
    const group = (name) => groups.find((row) => row.name === name);
    const cash = ledgers.find((row) => row.name === "Cash");
    assert(type("journal") && type("purchase") && type("sales") && type("receipt") && cash && units[0], "Public v0.4 seeded masters are incomplete");
    const createLedger = (input) => invoke("master:ledgers:create", { ...ledgerDefaults, ...input });

    const capital = await createLedger({ name: "Upgrade Test Capital", groupId: group("Capital Account").id });
    const journal = await invoke("voucher:save", { data: { voucherTypeId: type("journal").id, date: "2026-08-01", partyLedgerId: null, narration: "Created by public v0.4 candidate acceptance", reference: "V04-JOURNAL", instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: cash.id, drCr: "dr", amount: 12345, costAllocations: [] }, { ledgerId: capital.id, drCr: "cr", amount: 12345, costAllocations: [] }], inventory: [], billRefs: [], tds: null } });

    const stockGroup = await invoke("master:stockGroups:create", { name: "Upgrade Inventory", parentId: null });
    const item = await invoke("master:stockItems:create", { name: "Upgrade Widget", groupId: stockGroup.id, unitId: units[0].id, hsn: "8471", gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: "V04-WIDGET", reorderLevelMilli: 3000, valuationMethod: "weighted_avg" });
    const batch = await invoke("master:batches:create", { stockItemId: item.id, name: "LOT-V04", mfgDate: "2026-07-01", expiryDate: "2027-06-30" });
    const purchase = await createLedger({ name: "Upgrade Purchases", groupId: group("Purchase Accounts").id, gstRate: 18, hsn: "8471" });
    const supplier = await createLedger({ name: "Upgrade Supplier", groupId: group("Sundry Creditors").id, stateCode: "27" });
    const purchaseVoucher = await invoke("voucher:save", { data: { voucherTypeId: type("purchase").id, date: "2026-08-05", partyLedgerId: supplier.id, narration: "Batch receipt", reference: "V04-PURCHASE", instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: purchase.id, drCr: "dr", amount: 100000, costAllocations: [] }, { ledgerId: supplier.id, drCr: "cr", amount: 100000, costAllocations: [] }], inventory: [{ stockItemId: item.id, godownId: null, batchId: batch.id, qtyMilli: 5000, ratePaise: 20000, amount: 100000, direction: "in" }], billRefs: [], tds: null } });

    const customer = await createLedger({ name: "Upgrade Customer", groupId: group("Sundry Debtors").id, gstin: "27AAPFU0939F1ZV", stateCode: "27" });
    const sales = await createLedger({ name: "Upgrade Sales 18", groupId: group("Sales Accounts").id, gstRate: 18, hsn: "8471" });
    const cgst = await createLedger({ name: "Upgrade Output CGST", groupId: group("Duties & Taxes").id, taxType: "cgst" });
    const sgst = await createLedger({ name: "Upgrade Output SGST", groupId: group("Duties & Taxes").id, taxType: "sgst" });
    const salesVoucher = await invoke("voucher:save", { data: { voucherTypeId: type("sales").id, date: "2026-08-08", partyLedgerId: customer.id, narration: "GST batch sale", reference: "V04-GST-SALE", instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: customer.id, drCr: "dr", amount: 118000, costAllocations: [] }, { ledgerId: sales.id, drCr: "cr", amount: 100000, costAllocations: [] }, { ledgerId: cgst.id, drCr: "cr", amount: 9000, costAllocations: [] }, { ledgerId: sgst.id, drCr: "cr", amount: 9000, costAllocations: [] }], inventory: [{ stockItemId: item.id, godownId: null, batchId: batch.id, qtyMilli: 2000, ratePaise: 50000, amount: 100000, direction: "out" }], billRefs: [], tds: null } });

    const bankLedger = await createLedger({ name: "Upgrade Bank", groupId: group("Bank Accounts").id });
    const bankVoucher = await invoke("voucher:save", { data: { voucherTypeId: type("receipt").id, date: "2026-08-10", partyLedgerId: null, narration: "Bank receipt", reference: "V04-BANK", instrumentNo: "UTR-V04", instrumentDate: "2026-08-10", transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: bankLedger.id, drCr: "dr", amount: 75000, costAllocations: [] }, { ledgerId: capital.id, drCr: "cr", amount: 75000, costAllocations: [] }], inventory: [], billRefs: [], tds: null } });
    const bankImport = await invoke("bank:importCsv", { ledgerId: bankLedger.id, csvText: "Date,Description,Reference,Debit,Credit\n2026-08-10,Upgrade receipt,UTR-V04,,750.00", dryRun: false });
    assert(bankImport.matched === 1, "Public v0.4 bank statement did not reconcile the fixture receipt");

    const employee = await invoke("payroll:employees:save", { data: { name: "Upgrade Employee", code: "V04-E01", designation: "Operator", joined: "2026-04-01", pan: "ABCDE1234F", uan: null, esicNo: null, basic: 3000000, hra: 1200000, special: 300000, pfEnabled: false, esiEnabled: false, ptEnabled: false, ptState: "MH", active: true } });
    const payrollRun = await invoke("payroll:commit", { month: "2026-08", days: [{ employeeId: employee.id, payableDays: 31 }] });

    const section = (await invoke("tds:sections")).find((row) => row.code === "194C");
    assert(section, "Public v0.4 did not seed TDS section 194C");
    const contractor = await createLedger({ name: "Upgrade Contractor", groupId: group("Sundry Creditors").id, tdsSectionId: section.id, pan: "ABCDE1234F" });
    const tdsSuggestion = await invoke("tds:suggest", { partyLedgerId: contractor.id, base: 5000000, date: "2026-08-15" });
    assert(tdsSuggestion?.tdsPaise > 0, "Public v0.4 did not calculate representative TDS");
    const tdsVoucher = await invoke("voucher:save", { data: { voucherTypeId: type("journal").id, date: "2026-08-15", partyLedgerId: contractor.id, narration: "Contractor accrual with TDS", reference: "V04-TDS", instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: contractor.id, drCr: "dr", amount: 5000000, costAllocations: [] }, { ledgerId: cash.id, drCr: "cr", amount: 5000000 - tdsSuggestion.tdsPaise, costAllocations: [] }, { ledgerId: tdsSuggestion.payableLedgerId, drCr: "cr", amount: tdsSuggestion.tdsPaise, costAllocations: [] }], inventory: [], billRefs: [], tds: { sectionId: section.id, baseAmount: 5000000, tdsAmount: tdsSuggestion.tdsPaise } } });

    const owner = await invoke("users:save", { data: { name: "Upgrade Owner", role: "owner", pin: "2468", active: true } });
    await invoke("users:save", { data: { name: "Upgrade Viewer", role: "viewer", pin: "1357", active: true } });
    const fixture = { voucherIds: [journal.id, purchaseVoucher.id, salesVoucher.id, bankVoucher.id, payrollRun.voucherId, tdsVoucher.id], stockItemId: item.id, batchId: batch.id, bankLedgerId: bankLedger.id, payrollRunId: payrollRun.id, ownerId: owner.id, ownerPin: "2468" };
    const values = await snapshot(invoke, fixture);
    assert(values.vouchers.count >= 6, `Public v0.4 fixture created only ${values.vouchers.count} vouchers`);
    assert(values.trial.totalDebit === values.trial.totalCredit, "Public v0.4 representative trial balance does not tie");
    assert(values.inventory.closingQtyMilli === 3000 && values.batch.closingQtyMilli === 3000, "Public v0.4 inventory fixture does not reconcile");
    assert(values.banking.clearedRows === 1 && values.payroll.lines.length === 1, "Public v0.4 banking or payroll fixture is incomplete");
    assert(values.gst.some((row) => row.docs === 1 && row.taxable === 100000), "Public v0.4 GST fixture is incomplete");
    assert(values.tds.base === 5000000 && values.tds.tds === tdsSuggestion.tdsPaise, "Public v0.4 TDS fixture is incomplete");
    assert(values.users.length === 2, "Public v0.4 user fixture is incomplete");
    return { identity, slug: created.slug, fixture, values, fixtureDigest: digestFixture(values) };
  });
}

async function verifyCandidate(old, pass) {
  return withApp(candidateExecutable, async ({ invoke, identity }) => {
    assert(identity.version === expectedCandidateVersion, `Expected candidate ${expectedCandidateVersion}, got ${identity.version}`);
    const companies = await invoke("company:list");
    assert(companies.companies.some((company) => company.slug === old.slug), `Candidate cannot see migrated company ${old.slug}`);
    const opened = await invoke("company:open", { slug: old.slug });
    assert(opened.locked === true, `Candidate pass ${pass} did not preserve the v0.4 company lock`);
    const loginNames = await invoke("auth:users");
    assert(loginNames.some((row) => row.id === old.fixture.ownerId), `Candidate pass ${pass} lost the owner login`);
    await invoke("auth:login", { userId: old.fixture.ownerId, pin: old.fixture.ownerPin });
    const values = await snapshot(invoke, old.fixture);
    const fixtureDigest = digestFixture(values);
    assert(fixtureDigest === old.fixtureDigest, `Candidate pass ${pass} changed representative v0.4 data (${fixtureDigest} != ${old.fixtureDigest})`);
    let backup = null;
    if (pass === 1) {
      await invoke("backup:run");
      const backups = await invoke("backup:list");
      const row = backups.find((item) => item.tag === "manual") ?? backups[0];
      assert(row?.file, "Candidate did not list its post-migration backup");
      const preview = await invoke("backup:preview", { file: row.file });
      assert(preview.valid && preview.integrity === "ok" && preview.voucherCount === values.vouchers.count, `Post-migration backup is invalid: ${JSON.stringify(preview)}`);
      backup = { file: row.file, integrity: preview.integrity, voucherCount: preview.voucherCount };
    }
    return { pass, identity, values, fixtureDigest, backup };
  });
}

try {
  const old = await seedWithPublicRelease();
  const firstOpen = await verifyCandidate(old, 1);
  const secondOpen = await verifyCandidate(old, 2);
  const domains = [["inventory", firstOpen.values.inventory], ["batches", firstOpen.values.batch], ["banking", firstOpen.values.banking], ["payroll", firstOpen.values.payroll], ["gst", firstOpen.values.gst], ["tds", firstOpen.values.tds], ["usersLock", firstOpen.values.users]].map(([id, detail]) => ({ id, status: "passed", detail }));
  domains.push({ id: "attachments", status: "passed", publicReleaseSupported: false, reason: "Public v0.4.0 has no managed voucher-attachment IPC or storage, so there is no public-release attachment state to migrate." });
  const evidence = {
    schema: 2, ok: true, executed: true, checkedAt: new Date().toISOString(), platform, sourceRevision,
    transition: `${old.identity.version} -> ${firstOpen.identity.version}`,
    publicArtifact: { ...artifact(publicArtifactPath), version: old.identity.version },
    candidateExecutable: artifact(candidateExecutable), candidateArtifacts: candidateArtifacts(),
    publicRelease: old, candidateFirstOpen: firstOpen, candidateSecondOpen: secondOpen, domains,
    assertions: ["packaged-builds", "artifact-digests-linked", "shared-data-root", "registry-preserved", "migration-idempotent", "voucher-and-trial-balance-preserved", "inventory-and-batches-preserved", "banking-preserved", "payroll-preserved", "gst-and-tds-preserved", "users-and-lock-preserved", "attachment-capability-recorded", "verified-backup-after-migration"],
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
