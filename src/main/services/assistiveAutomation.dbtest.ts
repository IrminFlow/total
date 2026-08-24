import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { postSimpleVoucher, seededDb } from "../db/testdb";
import {
  addExtractedDocument,
  citedVarianceNarrative,
  collectionMessage,
  constrainedNaturalSearch,
  evidenceLedgerSuggestions,
  listDocumentInbox,
  listTaskRoutes,
  reconciliationExplanation,
  recordEvaluation,
  recordLedgerFeedback,
  reviewDocument,
  setTaskRoute,
} from "./assistiveAutomation";

let tempRoot: string | null = null;
afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function fixturePath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "total-assist-"));
  const path = join(tempRoot, "invoice.png");
  writeFileSync(path, Buffer.from("stable-image-fixture"));
  return path;
}

const extraction = {
  supplierOrMerchant: "Acme Supplies",
  documentNumber: "AC-42",
  date: "2026-08-24",
  gstin: "27ABCDE1234F1Z5",
  subtotal: 100_000,
  tax: 18_000,
  total: 118_000,
  items: [{ description: "Paper", quantityMilli: 2_000, amount: 100_000 }],
  confidenceBps: 9_400,
  warnings: [],
};

describe("assistive automation", () => {
  it("retains extraction evidence, flags duplicates, and records human review", () => {
    const db = seededDb();
    const path = fixturePath();
    const first = addExtractedDocument(
      db,
      "supplier_invoice",
      path,
      extraction,
      "Owner",
    );
    const second = addExtractedDocument(
      db,
      "supplier_invoice",
      path,
      extraction,
      "Owner",
    );
    expect(first.status).toBe("review");
    expect(second).toMatchObject({
      status: "duplicate",
      duplicateOfId: first.id,
    });
    expect(reviewDocument(db, first.id, "approved", "Reviewer")).toMatchObject({
      status: "approved",
      reviewedBy: "Reviewer",
    });
    expect(listDocumentInbox(db)).toHaveLength(2);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE entity='ai_document'")
        .get(),
    ).toEqual({ n: 3 });
  });

  it("ranks ledger evidence and learns only from explicit local feedback", () => {
    const db = seededDb();
    const voucher = postSimpleVoucher(db, {
      date: "2026-08-24",
      amount: 125_000,
      kind: "purchase",
    });
    const party = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    db.prepare(
      "UPDATE vouchers SET party_ledger_id=?,narration='Monthly courier shipment' WHERE id=?",
    ).run(party.id, voucher.id);
    const before = evidenceLedgerSuggestions(
      db,
      "purchase",
      "courier",
      "courier",
      party.id,
    );
    expect(before[0]).toMatchObject({
      name: "Sales Account",
      acceptedCount: 0,
      rejectedCount: 0,
    });
    expect(before[0]!.evidence.join(" ")).toMatch(
      /this party.*narration match/i,
    );
    recordLedgerFeedback(
      db,
      "courier",
      before[0]!.ledgerId,
      "accepted",
      "Owner",
    );
    const after = evidenceLedgerSuggestions(
      db,
      "purchase",
      "courier",
      "courier",
      party.id,
    );
    expect(after[0]!.score).toBeGreaterThan(before[0]!.score);
    expect(after[0]).toMatchObject({ acceptedCount: 1, rejectedCount: 0 });
  });

  it("searches approved indexes and exact integer-paise amounts with stable citations", () => {
    const db = seededDb();
    const voucher = postSimpleVoucher(db, {
      date: "2026-08-24",
      amount: 1_250_000,
      kind: "receipt",
    });
    expect(constrainedNaturalSearch(db, "find 12,500")).toContainEqual(
      expect.objectContaining({
        kind: "voucher",
        id: voucher.id,
        citation: `total://voucher/${voucher.id}`,
      }),
    );
    expect(constrainedNaturalSearch(db, "Cash")).toContainEqual(
      expect.objectContaining({ kind: "ledger", label: "Cash" }),
    );
    expect(constrainedNaturalSearch(db, "profit report")).toContainEqual(
      expect.objectContaining({
        kind: "report",
        label: "Profit & loss",
        citation: "total://report/profit-loss",
      }),
    );
  });

  it("explains reconciliation and period variance without uncited book claims", () => {
    const db = seededDb();
    const prior = postSimpleVoucher(db, {
      date: "2026-07-20",
      amount: 80_000,
      kind: "sales",
    });
    const current = postSimpleVoucher(db, {
      date: "2026-08-20",
      amount: 125_000,
      kind: "sales",
    });
    const recon = reconciliationExplanation("many_to_one", 205_000, [
      {
        voucherId: prior.id,
        date: prior.date,
        number: prior.number,
        amount: 80_000,
      },
      {
        voucherId: current.id,
        date: current.date,
        number: current.number,
        amount: 125_000,
      },
    ]);
    expect(recon).toMatchObject({
      citations: [
        `total://voucher/${prior.id}`,
        `total://voucher/${current.id}`,
      ],
    });
    expect(recon.reasons.join(" ")).toContain("Amounts agree exactly");
    const variance = citedVarianceNarrative(
      db,
      "2026-08-01",
      "2026-08-31",
      "2026-07-01",
      "2026-07-31",
    );
    expect(variance.text).toMatch(/Sales changed by ₹/);
    for (const citation of variance.citations)
      expect(citation).toMatch(/^total:\/\/voucher\/\d+$/);
  });

  it("grounds collection drafts in the receivable ledger balance", () => {
    const db = seededDb();
    const debtors = db
      .prepare("SELECT id FROM groups WHERE name='Sundry Debtors'")
      .get() as { id: number };
    const id = Number(
      db
        .prepare(
          "INSERT INTO ledgers(name,group_id,opening_balance) VALUES('Orchid Stores',?,250000)",
        )
        .run(debtors.id).lastInsertRowid,
    );
    const voucherType = db
      .prepare("SELECT id FROM voucher_types WHERE kind='sales'")
      .get() as { id: number };
    const cash = db
      .prepare("SELECT id FROM ledgers WHERE name='Cash'")
      .get() as { id: number };
    const voucherId = Number(
      db
        .prepare(
          "INSERT INTO vouchers(voucher_type_id,number,date,party_ledger_id) VALUES(?, 'S-1', '2026-08-01', ?)",
        )
        .run(voucherType.id, id).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO voucher_lines(voucher_id,ledger_id,dr_cr,amount) VALUES(?,?, 'dr', 250000),(?,?, 'cr', 250000)",
    ).run(voucherId, id, voucherId, cash.id);
    db.prepare(
      "INSERT INTO bill_refs(voucher_id,party_ledger_id,kind,name,amount,due_date) VALUES(?,?, 'new','S-1',250000,'2026-08-15')",
    ).run(voucherId, id);
    db.prepare("UPDATE ledgers SET opening_balance=0 WHERE id=?").run(id);
    const result = collectionMessage(db, id, "2026-08-24", "polite", [
      voucherId,
    ]);
    expect(result.message).toContain("Orchid Stores");
    expect(result.message).toContain("₹2,500.00");
    expect(result.message).toContain("S-1");
    expect(result.citations).toEqual([`total://voucher/${voucherId}`]);
  });

  it("persists owner-controlled task routes and evaluation metrics", () => {
    const db = seededDb();
    expect(listTaskRoutes(db)).toHaveLength(4);
    expect(
      setTaskRoute(
        db,
        { taskKind: "ocr", provider: "compatible", model: "vision-local" },
        "Owner",
      ).find((row) => row.taskKind === "ocr"),
    ).toMatchObject({
      provider: "compatible",
      model: "vision-local",
      updatedBy: "Owner",
    });
    const id = recordEvaluation(db, {
      fixtureSet: "invoice-v1",
      extractionAccuracyBps: 9300,
      citationValidityBps: 10000,
      draftValidityBps: 9700,
      details: { cases: 20 },
    });
    expect(
      db
        .prepare(
          "SELECT fixture_set fixtureSet,details_json details FROM ai_evaluation_runs WHERE id=?",
        )
        .get(id),
    ).toEqual({ fixtureSet: "invoice-v1", details: '{"cases":20}' });
  });
});
