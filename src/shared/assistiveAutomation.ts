export interface ExtractedDocument {
  supplierOrMerchant: string | null;
  documentNumber: string | null;
  date: string | null;
  gstin: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  items: {
    description: string;
    quantityMilli: number | null;
    amount: number | null;
  }[];
  confidenceBps: number;
  warnings: string[];
}
export interface DocumentInboxRow {
  id: number;
  documentKind: "supplier_invoice" | "receipt";
  sourcePath: string;
  sourceHash: string;
  status:
    "extracting" | "review" | "approved" | "dismissed" | "duplicate" | "failed";
  extracted: ExtractedDocument;
  duplicateOfId: number | null;
  voucherDraftId: number | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
export interface EvidenceSuggestion {
  ledgerId: number;
  name: string;
  groupName: string;
  score: number;
  evidence: string[];
  acceptedCount: number;
  rejectedCount: number;
}
export interface ConstrainedSearchResult {
  kind: "voucher" | "ledger" | "item" | "report";
  id: number;
  label: string;
  sub: string;
  citation: string;
}
export interface AiTaskRoute {
  taskKind: "ocr" | "classification" | "analysis" | "writing";
  provider: "default" | "openai" | "compatible";
  model: string | null;
  updatedBy: string;
  updatedAt: string;
}
