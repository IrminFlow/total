// Scenario 36 — operational inventory cockpit: planning, reservations, transfers, counts,
// versioned BOM production, traceability and printable warehouse labels.
import { scenario, assert } from "../lib/harness.mjs";

await scenario("36-inventory-control", async (h) => {
  const created = await h.invoke("company:createDemo");
  assert(created?.slug, "demo company created");
  await h.page.reload();
  await h.openCompany("Demo Traders", 60000);
  const today = "2026-08-24";
  const units = await h.invoke("master:units:list");
  const unit = units[0];
  const createItem = (name, barcode) =>
    h.invoke("master:stockItems:create", {
      name,
      groupId: null,
      unitId: unit.id,
      hsn: null,
      gstRate: 18,
      cessRate: null,
      openingQtyMilli: 0,
      openingValue: 0,
      barcode,
      reorderLevelMilli: null,
      valuationMethod: "weighted_avg",
    });
  const raw = await createItem("Roadmap Raw Material", "RAW-036");
  const finished = await createItem("Roadmap Finished Good", "FIN-036");
  const source = await h.invoke("master:godowns:create", {
    name: "Roadmap Plant",
    address: null,
    gstRegistrationId: null,
  });
  const destination = await h.invoke("master:godowns:create", {
    name: "Roadmap Depot",
    address: null,
    gstRegistrationId: null,
  });
  const types = await h.invoke("master:voucherTypes:list");
  const stock = types.find((t) => t.kind === "stock_journal");
  await h.invoke("voucher:save", {
    data: {
      voucherTypeId: stock.id,
      date: today,
      partyLedgerId: null,
      narration: "Inventory control opening receipt",
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [],
      inventory: [
        {
          stockItemId: raw.id,
          godownId: source.id,
          batchId: null,
          qtyMilli: 100000,
          ratePaise: 5000,
          amount: 500000,
          direction: "in",
        },
      ],
    },
  });
  await h.invoke("inventory:planning:save", {
    stockItemId: raw.id,
    leadTimeDays: 14,
    safetyStockMilli: 20000,
    reorderQtyMilli: 50000,
    preferredSupplierLedgerId: null,
    forecastMethod: "velocity",
  });
  await h.invoke("inventory:reservations:create", {
    stockItemId: raw.id,
    godownId: source.id,
    batchId: null,
    qtyMilli: 5000,
    requiredDate: today,
    reference: "SO-ROADMAP-36",
    customerLedgerId: null,
  });
  await h.invoke("inventory:transfers:create", {
    transferDate: today,
    fromGodownId: source.id,
    toGodownId: destination.id,
    expectedArrival: today,
    note: "Launch stock",
    lines: [{ stockItemId: raw.id, batchId: null, qtyMilli: 10000 }],
  });
  const bom = await h.invoke("inventory:bomVersions:create", {
    itemId: finished.id,
    version: "1.0",
    effectiveFrom: today,
    effectiveTo: null,
    note: "Public launch formula",
    lines: [{ componentId: raw.id, qtyMilliPerUnit: 2000, scrapPct: 0 }],
  });
  await h.invoke("inventory:bomVersions:activate", { id: bom.id });
  await h.invoke("inventory:manufacturing:create", {
    stockItemId: finished.id,
    plannedQtyMilli: 10000,
    dueDate: today,
    godownId: source.id,
    bomVersionId: bom.id,
    note: "Launch build",
  });
  await h.invoke("inventory:counts:create", {
    name: "Launch cycle count",
    countDate: today,
    godownId: source.id,
    blindCount: true,
  });

  await h.goto("inventory-control");
  await h.page.getByText("Supply decision desk", { exact: true }).waitFor();
  await h.page.getByText("Roadmap Raw Material", { exact: true }).waitFor();
  await h.shot("01-supply-decision-desk");
  await h.page
    .getByRole("button", { name: "Reservations", exact: true })
    .click();
  await h.page.getByText("SO-ROADMAP-36").waitFor();
  await h.shot("02-reservations");
  await h.page.getByRole("button", { name: "Transfers", exact: true }).click();
  await h.page
    .getByText("Roadmap Plant → Roadmap Depot", { exact: true })
    .waitFor();
  await h.page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await h.page.getByText("In transit", { exact: true }).waitFor();
  await h.shot("03-in-transit");
  await h.page
    .getByRole("button", { name: "Cycle counts", exact: true })
    .click();
  await h.page.getByText("Launch cycle count", { exact: true }).first().waitFor();
  await h.shot("04-cycle-count");
  await h.page.getByRole("button", { name: "Production", exact: true }).click();
  await h.page.getByText("Effective BOM revisions", { exact: true }).waitFor();
  await h.page.getByText("MO-00001").waitFor();
  await h.shot("05-production-control");
  await h.page
    .getByRole("button", { name: "Trace & labels", exact: true })
    .click();
  await h.page
    .getByText("Print barcode / QR labels", { exact: true })
    .waitFor();
  await h.page.getByRole("button", { name: "Create label PDF" }).click();
  await h.page.getByText(/Label sheet ready/).waitFor({ timeout: 60000 });
  await h.shot("06-traceability-labels");
});
