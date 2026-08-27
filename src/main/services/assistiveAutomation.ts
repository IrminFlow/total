import { createHash } from "crypto";
import { readFileSync } from "fs";
import type { DB } from "../db/connection";
import type {
  AiTaskRoute,
  ConstrainedSearchResult,
  DocumentInboxRow,
  EvidenceSuggestion,
  ExtractedDocument,
} from "@shared/assistiveAutomation";
import { globalSearch } from "./search";
import { suggestLedgers } from "./intel";
import { varianceExplanation } from "./managementInsights";
import { outstandings } from "./analysis";
import { writeAudit } from "./audit";
import { formatPaise } from "@shared/money";

type Row = Record<string, unknown>;
const blankExtraction = (): ExtractedDocument => ({
  supplierOrMerchant: null,
  documentNumber: null,
  date: null,
  gstin: null,
  subtotal: null,
  tax: null,
  total: null,
  items: [],
  confidenceBps: 0,
  warnings: ["Extraction has not completed"],
});
function mapDocument(row: Row): DocumentInboxRow {
  return {
    id: Number(row.id),
    documentKind: row.document_kind as DocumentInboxRow["documentKind"],
    sourcePath: String(row.source_path),
    sourceHash: String(row.source_hash),
    status: row.status as DocumentInboxRow["status"],
    extracted: JSON.parse(String(row.extracted_json)) as ExtractedDocument,
    duplicateOfId:
      row.duplicate_of_id == null ? null : Number(row.duplicate_of_id),
    voucherDraftId:
      row.voucher_draft_id == null ? null : Number(row.voucher_draft_id),
    error: row.error == null ? null : String(row.error),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
  };
}
export function listDocumentInbox(db: DB): DocumentInboxRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM ai_document_inbox ORDER BY created_at DESC,id DESC",
      )
      .all() as Row[]
  ).map(mapDocument);
}
export function addExtractedDocument(
  db: DB,
  kind: DocumentInboxRow["documentKind"],
  sourcePath: string,
  extracted: ExtractedDocument,
  actor: string,
): DocumentInboxRow {
  const hash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  const duplicate = db
    .prepare(
      `SELECT id FROM ai_document_inbox WHERE source_hash=? OR (? IS NOT NULL AND json_extract(extracted_json,'$.documentNumber')=? AND json_extract(extracted_json,'$.total')=?) ORDER BY id LIMIT 1`,
    )
    .get(
      hash,
      extracted.documentNumber,
      extracted.documentNumber,
      extracted.total,
    ) as { id: number } | undefined;
  const status = duplicate ? "duplicate" : "review";
  const id = Number(
    db
      .prepare(
        `INSERT INTO ai_document_inbox(document_kind,source_path,source_hash,status,extracted_json,duplicate_of_id,created_by) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        kind,
        sourcePath,
        hash,
        status,
        JSON.stringify(extracted),
        duplicate?.id ?? null,
        actor,
      ).lastInsertRowid,
  );
  const after = listDocumentInbox(db).find((row) => row.id === id)!;
  writeAudit(db, "ai_document", id, "create", null, after);
  return after;
}
export function reviewDocument(
  db: DB,
  id: number,
  status: "approved" | "dismissed",
  actor: string,
): DocumentInboxRow {
  const before = listDocumentInbox(db).find((row) => row.id === id);
  if (!before || !["review", "duplicate"].includes(before.status))
    throw new Error("Reviewable document not found");
  db.prepare(
    `UPDATE ai_document_inbox SET status=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?`,
  ).run(status, actor, id);
  const after = listDocumentInbox(db).find((row) => row.id === id)!;
  writeAudit(db, "ai_document", id, "update", before, after);
  return after;
}

export function evidenceLedgerSuggestions(
  db: DB,
  kind: string,
  query: string,
  contextKey: string,
  partyLedgerId?: number | null,
): EvidenceSuggestion[] {
  const base = suggestLedgers(db, kind, query, 20);
  const like = `%${query.trim()}%`;
  const history = db
    .prepare(
      `SELECT l.id AS ledgerId,l.name,g.name AS groupName,COUNT(*) AS uses,
              SUM(CASE WHEN ? IS NOT NULL AND v.party_ledger_id=? THEN 1 ELSE 0 END) AS partyUses,
              SUM(CASE WHEN ?<>'' AND COALESCE(v.narration,'') LIKE ? COLLATE NOCASE THEN 1 ELSE 0 END) AS narrationUses
       FROM voucher_lines vl
       JOIN vouchers v ON v.id=vl.voucher_id
       JOIN voucher_types vt ON vt.id=v.voucher_type_id
       JOIN ledgers l ON l.id=vl.ledger_id
       JOIN groups g ON g.id=l.group_id
       WHERE vt.kind=? AND v.deleted_at IS NULL AND l.id<>COALESCE(?,-1)
         AND ((? IS NOT NULL AND v.party_ledger_id=?) OR (?<>'' AND COALESCE(v.narration,'') LIKE ? COLLATE NOCASE))
       GROUP BY l.id,l.name,g.name
       ORDER BY partyUses DESC,narrationUses DESC,uses DESC,l.name
       LIMIT 40`,
    )
    .all(
      partyLedgerId ?? null,
      partyLedgerId ?? null,
      query.trim(),
      like,
      kind,
      partyLedgerId ?? null,
      partyLedgerId ?? null,
      partyLedgerId ?? null,
      query.trim(),
      like,
    ) as {
    ledgerId: number;
    name: string;
    groupName: string;
    uses: number;
    partyUses: number;
    narrationUses: number;
  }[];
  const candidates = new Map<
    number,
    {
      ledgerId: number;
      name: string;
      groupName: string;
      uses: number;
      partyUses: number;
      narrationUses: number;
    }
  >();
  for (const row of base)
    candidates.set(row.ledgerId, {
      ...row,
      partyUses: 0,
      narrationUses: 0,
    });
  for (const row of history) {
    const existing = candidates.get(row.ledgerId);
    candidates.set(row.ledgerId, {
      ...row,
      uses: Math.max(row.uses, existing?.uses ?? 0),
    });
  }
  const feedback = db
    .prepare(
      `SELECT ledger_id ledgerId,outcome,COUNT(*) n FROM ai_ledger_feedback WHERE context_kind='ledger_suggestion' AND context_key=? GROUP BY ledger_id,outcome`,
    )
    .all(contextKey) as {
    ledgerId: number;
    outcome: "accepted" | "rejected";
    n: number;
  }[];
  return [...candidates.values()]
    .map((row) => {
      const accepted =
        feedback.find(
          (f) => f.ledgerId === row.ledgerId && f.outcome === "accepted",
        )?.n ?? 0;
      const rejected =
        feedback.find(
          (f) => f.ledgerId === row.ledgerId && f.outcome === "rejected",
        )?.n ?? 0;
      const score = Math.max(
        0,
        row.uses * 100 +
          row.partyUses * 300 +
          row.narrationUses * 250 +
          accepted * 250 -
          rejected * 300 +
          (row.name.toLowerCase().includes(query.toLowerCase()) ? 100 : 0),
      );
      return {
        ...row,
        score,
        evidence: [
          `${row.uses} prior use${row.uses === 1 ? "" : "s"} in ${kind} vouchers`,
          row.partyUses
            ? `${row.partyUses} prior posting${row.partyUses === 1 ? "" : "s"} for this party`
            : partyLedgerId
              ? "No prior posting for the selected party"
              : "No party context selected",
          row.narrationUses
            ? `${row.narrationUses} narration match${row.narrationUses === 1 ? "" : "es"} for “${query}”`
            : query && row.name.toLowerCase().includes(query.toLowerCase())
              ? `Ledger name matched “${query}”`
              : "Ranked by voucher history",
          accepted
            ? `${accepted} locally accepted suggestion${accepted === 1 ? "" : "s"}`
            : "No local acceptance history",
        ].filter(Boolean),
        acceptedCount: accepted,
        rejectedCount: rejected,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);
}
export function recordLedgerFeedback(
  db: DB,
  contextKey: string,
  ledgerId: number,
  outcome: "accepted" | "rejected",
  actor: string,
): void {
  if (!db.prepare("SELECT 1 FROM ledgers WHERE id=?").get(ledgerId))
    throw new Error("Ledger not found");
  const id = Number(
    db
      .prepare(
        `INSERT INTO ai_ledger_feedback(context_kind,context_key,ledger_id,outcome,created_by) VALUES('ledger_suggestion',?,?,?,?)`,
      )
      .run(contextKey, ledgerId, outcome, actor).lastInsertRowid,
  );
  writeAudit(db, "ai_feedback", id, "create", null, {
    contextKey,
    ledgerId,
    outcome,
  });
}

export function constrainedNaturalSearch(
  db: DB,
  query: string,
): ConstrainedSearchResult[] {
  const q = query.trim();
  const hits = globalSearch(db, q).map(
    (hit) =>
      ({
        ...hit,
        citation: `total://${hit.kind}/${hit.id}`,
      }) as ConstrainedSearchResult,
  );
  const reports = [
    [
      1,
      "Trial balance",
      "Closing debit and credit balances",
      "trial-balance",
      "trial balance tb closing balances report",
    ],
    [
      2,
      "Profit & loss",
      "Income, expenses and period result",
      "profit-loss",
      "profit loss pnl income expense margin report",
    ],
    [
      3,
      "Balance sheet",
      "Assets, liabilities and equity",
      "balance-sheet",
      "balance sheet assets liabilities equity report",
    ],
    [
      4,
      "Cash flow",
      "Operating, investing and financing cash",
      "cash-flow",
      "cash flow operating investing financing report",
    ],
    [
      5,
      "Sales register",
      "Monthly and quarterly outward vouchers",
      "registers",
      "sales register quarterly monthly report",
    ],
    [
      6,
      "Purchase register",
      "Monthly and quarterly inward vouchers",
      "registers",
      "purchase register quarterly monthly report",
    ],
    [
      7,
      "GSTR-1",
      "Outward supply return",
      "gstr1",
      "gstr1 gst sales return outward report",
    ],
    [
      8,
      "GSTR-3B",
      "Summary return and ITC",
      "gstr3b",
      "gstr3b gst summary itc return report",
    ],
    [
      9,
      "Outstandings",
      "Receivables and payables by bill",
      "outstandings",
      "outstanding receivable payable debtors creditors bills report",
    ],
    [
      10,
      "Stock summary",
      "Inventory quantities and value",
      "stock-summary",
      "stock inventory quantity value report",
    ],
  ] as const;
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1);
  for (const [id, label, sub, slug, aliases] of reports) {
    if (words.length && words.every((word) => aliases.includes(word)))
      hits.push({
        kind: "report",
        id,
        label,
        sub,
        citation: `total://report/${slug}`,
      });
  }
  const amount = q.match(/(?:₹|rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/i);
  if (amount) {
    const paise = Math.round(Number(amount[1]!.replace(/,/g, "")) * 100);
    const rows = db
      .prepare(
        `SELECT DISTINCT v.id,vt.name type,v.number,v.date FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id JOIN voucher_lines vl ON vl.voucher_id=v.id WHERE vl.amount=? AND v.deleted_at IS NULL ORDER BY v.date DESC LIMIT 20`,
      )
      .all(paise) as {
      id: number;
      type: string;
      number: string;
      date: string;
    }[];
    for (const row of rows)
      hits.push({
        kind: "voucher",
        id: row.id,
        label: `${row.type} ${row.number}`,
        sub: `Exact amount match · ${row.date}`,
        citation: `total://voucher/${row.id}`,
      });
  }
  return [
    ...new Map(hits.map((hit) => [`${hit.kind}:${hit.id}`, hit])).values(),
  ].slice(0, 30);
}

export function reconciliationExplanation(
  kind: "tolerance" | "many_to_one",
  statementAmount: number,
  lines: { voucherId: number; date: string; number: string; amount: number }[],
): { summary: string; reasons: string[]; citations: string[] } {
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const difference = statementAmount - total;
  return {
    summary:
      kind === "many_to_one"
        ? `${lines.length} open entries jointly explain the statement amount`
        : "The closest same-direction book entry is within the configured tolerance",
    reasons: [
      `Book total ₹${formatPaise(total)} versus statement ₹${formatPaise(statementAmount)}`,
      difference === 0
        ? "Amounts agree exactly"
        : `Difference ₹${formatPaise(Math.abs(difference))} requires tolerance review`,
      kind === "many_to_one"
        ? `${lines.length} entries were combined to reach the proposed book total`
        : "This is the closest amount candidate supplied by reconciliation",
      kind === "many_to_one"
        ? "Lower-ranked combinations either exceeded the amount tolerance or mixed party groups"
        : "Lower-ranked entries had a larger date or amount gap, or fell outside the review window",
    ],
    citations: lines.map((line) => `total://voucher/${line.voucherId}`),
  };
}
export function citedVarianceNarrative(
  db: DB,
  currentFrom: string,
  currentTo: string,
  comparisonFrom: string,
  comparisonTo: string,
): { text: string; citations: string[] } {
  const report = varianceExplanation(
    db,
    currentFrom,
    currentTo,
    comparisonFrom,
    comparisonTo,
  );
  const top = report.drivers.slice(0, 3);
  const sentence = top.length
    ? top
        .map(
          (row) =>
            `${row.name} ${row.change >= 0 ? "increased" : "decreased"} by ₹${formatPaise(Math.abs(row.change))}`,
        )
        .join("; ")
    : "No material customer, supplier or item drivers were found";
  return {
    text: `Sales changed by ₹${formatPaise(Math.abs(report.salesChange))} (${report.salesChange >= 0 ? "up" : "down"}) and purchases by ₹${formatPaise(Math.abs(report.purchaseChange))} (${report.purchaseChange >= 0 ? "up" : "down"}). ${sentence}.`,
    citations: top.flatMap((row) =>
      row.voucherIds.map((id) => `total://voucher/${id}`),
    ),
  };
}
export function collectionMessage(
  db: DB,
  ledgerId: number,
  asOn: string,
  tone: "polite" | "firm",
  billVoucherIds: number[],
): { message: string; citations: string[] } {
  const party = outstandings(db, "receivable", asOn).find(
    (row) => row.ledgerId === ledgerId,
  );
  if (!party) throw new Error("No receivable balance found for this customer");
  const selectedIds = new Set(billVoucherIds);
  const bills = party.bills.filter(
    (bill) => bill.voucherId != null && selectedIds.has(bill.voucherId),
  );
  if (bills.length === 0) throw new Error("Select at least one open invoice");
  if (new Set(bills.map((bill) => bill.voucherId)).size !== selectedIds.size)
    throw new Error(
      "One or more selected invoices are not open for this customer",
    );
  const selectedAmount = bills.reduce((sum, bill) => sum + bill.pending, 0);
  const amount = (selectedAmount / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const invoices = bills.map((bill) => bill.number).join(", ");
  return {
    message:
      tone === "firm"
        ? `Dear ${party.name}, our records show ₹${amount} outstanding on invoice${bills.length === 1 ? "" : "s"} ${invoices} as of ${asOn}. Please arrange payment or share the expected payment date. This is a draft for your review.`
        : `Hello ${party.name}, a gentle reminder that ₹${amount} remains outstanding on invoice${bills.length === 1 ? "" : "s"} ${invoices} as of ${asOn}. Please let us know if you need any invoice copies. This is an editable draft.`,
    citations: bills.map((bill) => `total://voucher/${bill.voucherId}`),
  };
}

export function listTaskRoutes(db: DB): AiTaskRoute[] {
  return db
    .prepare(
      `SELECT task_kind taskKind,provider,model,updated_by updatedBy,updated_at updatedAt FROM ai_task_routes ORDER BY task_kind`,
    )
    .all() as AiTaskRoute[];
}
export function setTaskRoute(
  db: DB,
  input: {
    taskKind: AiTaskRoute["taskKind"];
    provider: AiTaskRoute["provider"];
    model: string | null;
  },
  actor: string,
): AiTaskRoute[] {
  if (input.provider === "offline" && input.taskKind !== "ocr")
    throw new Error("The bundled offline engine is available only for OCR");
  const before = listTaskRoutes(db);
  db.prepare(
    `UPDATE ai_task_routes SET provider=?,model=?,updated_by=?,updated_at=datetime('now') WHERE task_kind=?`,
  ).run(input.provider, input.model?.trim() || null, actor, input.taskKind);
  const after = listTaskRoutes(db);
  writeAudit(db, "ai_task_route", 0, "update", before, after);
  return after;
}
export function recordEvaluation(
  db: DB,
  input: {
    fixtureSet: string;
    extractionAccuracyBps: number;
    citationValidityBps: number;
    draftValidityBps: number;
    details?: unknown;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO ai_evaluation_runs(fixture_set,extraction_accuracy_bps,citation_validity_bps,draft_validity_bps,details_json) VALUES(?,?,?,?,?)`,
      )
      .run(
        input.fixtureSet,
        input.extractionAccuracyBps,
        input.citationValidityBps,
        input.draftValidityBps,
        JSON.stringify(input.details ?? {}),
      ).lastInsertRowid,
  );
}
export { blankExtraction };
