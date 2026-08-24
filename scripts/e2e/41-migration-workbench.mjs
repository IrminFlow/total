// Scenario 41 — reusable source mappings, balanced journal migration and portable exit package.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("41-migration-workbench", async (h) => {
  await h.createCompanyUI("Migration Ready Books");
  const groups = await h.invoke("master:groups:list");
  await h.invoke("master:ledgers:create", {
    name: "Migration Sales",
    groupId: groups.find((row) => row.name === "Sales Accounts").id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null,
  });
  const profiles = await h.invoke("import:profiles:list");
  assert(
    profiles.length >= 10,
    "Busy, Zoho Books and Marg master/transaction profiles are seeded",
  );
  const busy = profiles.find((row) => row.name === "Busy voucher export");
  const source = [
    "Vch No,Date,Vch Type,Account,Dr,Cr,Narration,Legacy Code",
    "B-100,24/08/2026,Journal,Cash,1250,,Busy migration,L1",
    "B-100,24/08/2026,Journal,Migration Sales,,1250,Busy migration,L2",
  ].join("\n");
  const preview = await h.invoke("import:profilePreview", {
    profileId: busy.id,
    csvText: source,
  });
  assertEq(
    preview.preview.willCreate,
    1,
    "Busy profile normalizes one balanced voucher",
  );
  assert(
    preview.dryRun.unsupportedColumns.includes("Legacy Code"),
    "dry run identifies unsupported source columns",
  );
  const applied = await h.invoke("import:profileApply", {
    profileId: busy.id,
    csvText: source,
  });
  assertEq(applied.created, 1, "profile import posts one voucher");
  const portable = await h.invoke("export:portable");
  assert(
    portable.manifestHash.length === 64,
    "portable package has content identity",
  );
  assertEq(
    portable.counts.vouchers,
    1,
    "portable package contains imported voucher",
  );

  await h.page.getByTitle("Company details").click();
  await h.waitScreen("company-info");
  await h.page
    .getByRole("heading", { name: "Import from spreadsheet" })
    .scrollIntoViewIfNeeded();
  await h.page.getByLabel("Saved mapping profile").selectOption({ label: "Busy voucher export" });
  await h.shot("01-migration-workbench");
  await h.page.getByRole("button", { name: "Manage mappings" }).click();
  await h.page.getByText("New import mapping", { exact: true }).waitFor();
  await h.shot("02-mapping-profile-builder");
});
